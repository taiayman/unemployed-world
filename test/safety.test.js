import test from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../src/http.js';
import { loadConfig } from '../src/pipeline.js';
import { openDb, ingestPosting } from '../src/db.js';
import { tagNewPostings } from '../src/tagger.js';
import { normalizeJobs } from '../src/sources/jobs.js';

const config = loadConfig();

test('public same-origin redirects work, but credentials never cross origins', async () => {
  let calls = 0;
  const http = new Http(config.http, { sleepImpl: async () => {}, fetchImpl: async () => {
    calls++;
    return calls === 1 ? new Response('', { status: 307, headers: { location: '/cached/file' } }) : new Response('{"ok":true}');
  } });
  assert.equal((await http.json('https://example.com/file')).ok, true);
  assert.equal(calls, 2);
  const unsafe = new Http(config.http, { sleepImpl: async () => {}, fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://other.test/' } }) });
  await assert.rejects(unsafe.json('https://example.com', { headers: { Authorization: 'secret' } }), /Unsafe/);
});

test('schema drift is an error, never a false zero-posting sample', () => {
  for (const kind of ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'adzuna', 'usajobs', 'arbeitnow', 'himalayas', 'remotive', 'remoteok']) assert.throws(() => normalizeJobs(kind, {}), /schema/);
});

async function tagScenario(modelData, response, llmConfig = config.llm) {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO occupations VALUES(?,?,?)').run('15-1252.00', 'Software Developers', '{}');
  ingestPosting(db, 'fixture', { title: 'Software Developer', company: 'Example', location: 'Remote', description: 'Develop software', url: 'https://example.test/1' });
  const oldKey = process.env.OPENROUTER_API_KEY, oldAck = process.env.OPENROUTER_BILLING_ACK;
  process.env.OPENROUTER_API_KEY = 'fixture'; process.env.OPENROUTER_BILLING_ACK = 'dedicated-key-monthly-limit-configured';
  let paidCalls = 0;
  try {
    const options = { allowPaid: true, checkpoint: async () => {}, log: () => {} };
    const http = { json: async u => {
      if (u.endsWith('/models')) return modelData;
      paidCalls++;
      if (response instanceof Error) throw response;
      return response;
    } };
    const first = await tagNewPostings(db, http, llmConfig, options);
    const second = await tagNewPostings(db, http, llmConfig, options);
    return { first, second, paidCalls, reserved: db.prepare('SELECT SUM(reserved_micros) n FROM budget').get().n,
      attempts: db.prepare('SELECT count FROM attempts').get()?.count };
  } finally {
    if (oldKey == null) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
    if (oldAck == null) delete process.env.OPENROUTER_BILLING_ACK; else process.env.OPENROUTER_BILLING_ACK = oldAck;
    db.close();
  }
}
const model = { data: [{ id: config.llm.model, pricing: { prompt: '0', completion: '0' } }] };

test('an unavailable requested model never silently falls back', async () => {
  const result = await tagScenario({ data: [{ id: 'different-model' }] });
  assert.equal(result.first.state, 'requested_model_unavailable');
  assert.equal(result.paidCalls, 0);
});

test('zero monthly cap means no paid request', async () => {
  const result = await tagScenario(model, null, { ...config.llm, monthlyUsd: 0 });
  assert.equal(result.first.state, 'monthly_cap_reached'); assert.equal(result.paidCalls, 0);
});

test('ambiguous calls retain reservations and attempt bounds stop later rebilling', async () => {
  const result = await tagScenario(model, new Error('timeout'), { ...config.llm, maxAttemptsPerHash: 1 });
  assert.equal(result.first.state, 'batch_failed'); assert.equal(result.second.state, 'nothing_new');
  assert.equal(result.paidCalls, 1); assert.equal(result.attempts, 1); assert.ok(result.reserved > 0);
});

test('a reported billing anomaly blocks every subsequent paid request', async () => {
  const result = await tagScenario(model, { usage: { cost: 100 }, choices: [{ finish_reason: 'stop', message: { content: '{"jobs":[]}' } }] });
  assert.equal(result.first.state, 'batch_failed'); assert.equal(result.second.state, 'billing_blocked');
  assert.equal(result.paidCalls, 1);
});
