import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { openDb, ingestPosting, sourceRun, prune } from '../src/db.js';
import { ago, hash, canonicalUrl } from '../src/util.js';
import { demandChange, flightStatus, exposureScore, buildExport } from '../src/metrics.js';
import { reserveBudget, validateTags, tagNewPostings } from '../src/tagger.js';
import { importOnet, importEconomicIndex } from '../scripts/import-exposure.js';
import { importPublishedReference } from '../src/reference.js';
import { Http } from '../src/http.js';
import { sentimentScore, ingestSentiment } from '../src/sources/sentiment.js';
import { parseFeed } from '../src/sources/news.js';
import { normalizeJobs, jobSources } from '../src/sources/jobs.js';
import { collectGroup, loadConfig } from '../src/pipeline.js';

const config = loadConfig();
const now = new Date('2026-10-18T12:00:00Z');
const posting = { id: '1', title: 'Software Developer', company: 'Example', location: 'Remote', description: 'Build software with JavaScript', url: 'https://example.com/jobs/1' };
const onetProvenance = { url: 'https://www.onetcenter.org/database.html', version: '31.0' };
const economicProvenance = { url: 'https://www.anthropic.com/economic-index', version: 'test', definition: 'test fixtures only' };
function taxonomy(db) {
  importOnet(db, [{ 'O*NET-SOC Code': '15-1252.00', Title: 'Software Developers' }], [
    { 'O*NET-SOC Code': '15-1252.00', 'Task ID': '1', Task: 'Develop software.' },
    { 'O*NET-SOC Code': '15-1252.00', 'Task ID': '2', Task: 'Discuss requirements.' }
  ], onetProvenance);
}
function tag(db, id) {
  const p = db.prepare('SELECT * FROM postings WHERE id=?').get(id);
  const t = { id: p.content_hash, skills: ['JavaScript'], seniority: 'mid', remote: 'remote', onet: '15-1252.00', confidence: 0.9 };
  db.prepare('INSERT OR IGNORE INTO tags VALUES(?,?,?,?,?)').run(p.content_hash, config.llm.promptVersion, config.llm.model, JSON.stringify(t), now.toISOString());
}

test('dedupe cross-source by normalized tuple, URL, and native id before tagging', () => {
  const db = openDb(':memory:');
  ingestPosting(db, 'lever:example', posting, '2026-10-18');
  ingestPosting(db, 'greenhouse:example', { ...posting, id: 'other', url: 'https://another.test/1', title: ' SOFTWARE  developer ', description: 'Syndicated variation' }, '2026-10-18');
  ingestPosting(db, 'lever:example', { ...posting, title: 'Edited title', location: 'New location', description: 'Edited' }, '2026-10-19');
  assert.equal(db.prepare('SELECT count(*) n FROM postings').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM observations').get().n, 3);
  assert.equal(db.prepare('SELECT description FROM postings').get().description, posting.description);
  db.close();
});

test('URL tracking parameters do not defeat deduplication', () => {
  assert.equal(canonicalUrl('https://example.com/a?utm_source=x&job=1#foo'), 'https://example.com/a?job=1');
});

test('UTC monthly budget is atomic, conservative and rolls over by month', () => {
  const db = openDb(':memory:');
  assert.ok(reserveBudget(db, { monthlyUsd: 0.001 }, 800, now));
  assert.equal(reserveBudget(db, { monthlyUsd: 0.001 }, 201, now), null);
  assert.ok(reserveBudget(db, { monthlyUsd: 0.001 }, 200, now));
  assert.ok(reserveBudget(db, { monthlyUsd: 0.001 }, 1000, new Date('2026-11-01T00:00:00Z')));
  assert.throws(() => reserveBudget(db, { monthlyUsd: -1 }, 1, now));
  db.close();
});

test('tag validation rejects invented occupations, duplicates and malformed skills', () => {
  const jobs = [{ content_hash: 'h' }], allowed = new Map([['h', new Set(['15-1252.00'])]]);
  const t = { id: 'h', skills: ['JS'], seniority: 'mid', remote: 'remote', onet: '15-1252.00', confidence: 0.9 };
  assert.deepEqual(validateTags({ jobs: [t] }, jobs, allowed), [t]);
  assert.throws(() => validateTags({ jobs: [{ ...t, onet: 'made-up' }] }, jobs, allowed));
  assert.throws(() => validateTags({ jobs: [{ ...t, skills: ['<script>'] }] }, jobs, allowed));
  assert.throws(() => validateTags({ jobs: [t, t] }, jobs, allowed));
});

test('paid call happens only after a persisted reservation; cache avoids all repeat calls', async () => {
  const db = openDb(':memory:'); taxonomy(db); ingestPosting(db, 'test', posting);
  const oldKey = process.env.OPENROUTER_API_KEY, oldAck = process.env.OPENROUTER_BILLING_ACK;
  process.env.OPENROUTER_API_KEY = 'fixture'; process.env.OPENROUTER_BILLING_ACK = 'dedicated-key-monthly-limit-configured';
  let persisted = false, calls = 0;
  const http = { json: async (url, options) => {
    calls++;
    if (url.endsWith('/models')) return { data: [{ id: config.llm.model, pricing: { prompt: '0.00000006', completion: '0.00000014' }, context_length: 100000 }] };
    if (url.endsWith('/key')) return { data: { limit: 5, limit_reset: 'monthly', limit_remaining: 5 } };
    assert.ok(persisted);
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ jobs: input.map(j => ({ id: j.id, skills: ['JavaScript'], seniority: 'mid', remote: 'remote', onet: j.onet_candidates[0]?.code || null, confidence: 0.9 })) }) } }], usage: { cost: 0.0001 } };
  } };
  try {
    const options = { allowPaid: true, checkpoint: async () => { assert.ok(db.prepare('SELECT count(*) n FROM budget').get().n > 0); persisted = true; } };
    assert.equal((await tagNewPostings(db, http, config.llm, options)).tagged, 1);
    assert.equal((await tagNewPostings(db, http, config.llm, options)).state, 'nothing_new');
    assert.equal(calls, 3);
  } finally {
    if (oldKey == null) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
    if (oldAck == null) delete process.env.OPENROUTER_BILLING_ACK; else process.env.OPENROUTER_BILLING_ACK = oldAck;
    db.close();
  }
});

test('failed persistence prevents the paid request', async () => {
  const db = openDb(':memory:'); taxonomy(db); ingestPosting(db, 'test', posting);
  const oldKey = process.env.OPENROUTER_API_KEY, oldAck = process.env.OPENROUTER_BILLING_ACK;
  process.env.OPENROUTER_API_KEY = 'fixture'; process.env.OPENROUTER_BILLING_ACK = 'dedicated-key-monthly-limit-configured';
  let paid = 0;
  try {
    await assert.rejects(tagNewPostings(db, { json: async u => {
      if (u.endsWith('/key')) return { data: { limit: 5, limit_reset: 'monthly' } };
      if (!u.endsWith('/models')) paid++;
      return { data: [{ id: config.llm.model, pricing: { prompt: '0', completion: '0' } }] };
    } }, config.llm, { allowPaid: true, checkpoint: async () => { throw new Error('push failed'); } }), /push failed/);
    assert.equal(paid, 0);
  } finally {
    if (oldKey == null) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
    if (oldAck == null) delete process.env.OPENROUTER_BILLING_ACK; else process.env.OPENROUTER_BILLING_ACK = oldAck;
    db.close();
  }
});

test('status boundaries match the supplied UI', () => {
  assert.deepEqual([null, -30, -29, -18, -17, -8, -7, 7, 8].map(flightStatus), [null, 'CANCELLED', 'FINAL CALL', 'FINAL CALL', 'DELAYED', 'DELAYED', 'ON TIME', 'ON TIME', 'BOARDING']);
});

function demandFixture(db, { baseline = 10, current = 15 } = {}) {
  const ids = new Set();
  for (let i = 0; i < 7; i++) for (const [daysAgo, count] of [[96 - i, baseline], [6 - i, current]]) {
    const d = ago(daysAgo, now);
    sourceRun(db, d, 'jobs:test', 'ok', count, null, { version: 1 });
    for (let j = 0; j < count; j++) ingestPosting(db, 'test', { ...posting, id: `p${j}`, company: `Employer ${j}`, url: `https://example.test/${j}` }, d);
  }
  for (const p of db.prepare('SELECT id FROM postings').all()) ids.add(p.id);
  return [...ids];
}

test('90-day demand uses matched windows, dedupes observations and computes 50%', () => {
  const db = openDb(':memory:');
  const ids = demandFixture(db);
  const metric = demandChange(db, ids, config.metrics, now);
  assert.equal(metric.change, 50); assert.equal(metric.baseline, 10); assert.equal(metric.current, 15);
  assert.equal(metric.matchedDays, 7);
  db.close();
});

test('cold start, zero baseline and missing days never turn into invented demand', () => {
  const db = openDb(':memory:');
  assert.equal(demandChange(db, [], config.metrics, now).change, null);
  const ids = demandFixture(db, { baseline: 0 });
  assert.equal(demandChange(db, ids, config.metrics, now).state, 'insufficient_baseline');
  db.prepare("UPDATE source_runs SET status='error' WHERE day IN (?,?)").run(ago(1, now), ago(2, now));
  assert.equal(demandChange(db, ids, config.metrics, now).state, 'collecting_history');
  db.close();
});

test('source configuration changes invalidate a baseline', () => {
  const db = openDb(':memory:'); const ids = demandFixture(db);
  db.prepare('UPDATE source_runs SET config_hash=? WHERE day>=?').run('changed', ago(6, now));
  assert.equal(demandChange(db, ids, config.metrics, now).change, null); db.close();
});

test('large source composition shifts suppress aggregate demand', () => {
  const db = openDb(':memory:'); const ids = demandFixture(db, { baseline: 10, current: 1 });
  for (let i = 0; i < 7; i++) for (const [daysAgo, count] of [[96 - i, 1], [6 - i, 10]]) {
    sourceRun(db, ago(daysAgo, now), 'jobs:other', 'ok', count, null, {});
    for (let j = 0; j < count; j++) ingestPosting(db, 'other', { ...posting, id: `x${j}`, company: `Other ${j}`, url: `https://other.test/${j}` }, ago(daysAgo, now));
  }
  assert.equal(demandChange(db, ids, config.metrics, now).state, 'source_mix_changed'); db.close();
});

test('exposure is null without data, and a measured proxy with coverage', () => {
  const db = openDb(':memory:'); taxonomy(db);
  assert.equal(exposureScore(db, '15-1252.00').score, null);
  importEconomicIndex(db, [{ onet_code: '15-1252.00', task_id: '1', automation_share: '0.6', augmentation_share: '0.4', usage_share: '' }], economicProvenance);
  assert.equal(exposureScore(db, '15-1252.00').score, 80);
  assert.equal(exposureScore(db, '15-1252.00').taskCoverage, 0.5);
  assert.throws(() => importEconomicIndex(db, [{ onet_code: '15-1252.00', task_id: '2', automation_share: '60', augmentation_share: '40' }], economicProvenance));
  assert.throws(() => importEconomicIndex(db, [{ onet_code: '15-1252.00', task_id: '999', automation_share: '0.1', augmentation_share: '0.1' }], economicProvenance));
  db.close();
});

test('published Economic Index is imported with exact task and SOC matches', () => {
  const db = openDb(':memory:');
  const out = importPublishedReference(db,
    [{ 'O*NET-SOC Code': '15-1252.00', Title: 'Software Developers' }],
    [{ 'O*NET-SOC Code': '15-1252.00', 'Task ID': '1', Task: 'Develop software.' }],
    [{ occ_code: '15-1252', observed_exposure: '0.5' }], [{ task: 'Develop software.', penetration: '0.75' }],
    { onet: onetProvenance, economic: economicProvenance });
  assert.equal(out.matchedTasks, 1);
  assert.equal(exposureScore(db, '15-1252.00').score, 50);
  assert.equal(exposureScore(db, '15-1252.00').taskCoverage, 1); db.close();
});

test('feed parsers accept RSS and Atom but reject HTML and DTDs', () => {
  assert.equal(parseFeed('<rss><channel><item><title>Release</title><link>https://example.com/new</link></item></channel></rss>')[0].title, 'Release');
  assert.equal(parseFeed('<feed><entry><title>Paper</title><link href="https://arxiv.org/abs/1"/></entry></feed>')[0].url, 'https://arxiv.org/abs/1');
  assert.throws(() => parseFeed('<html><body>Not RSS</body></html>'));
  assert.throws(() => parseFeed('<!DOCTYPE rss><rss/>'));
});

test('sentiment relevance, negation, dedupe, and privacy', () => {
  const db = openDb(':memory:');
  assert.equal(sentimentScore('nice weather'), null);
  assert.ok(sentimentScore('We are hiring for jobs') > 0);
  assert.ok(sentimentScore('We are not hiring') < 0);
  assert.ok(sentimentScore('AI layoffs and unemployed workers') < 0);
  assert.equal(ingestSentiment(db, 'test', { id: 'secret-id', text: 'We are hiring' }), true);
  assert.equal(ingestSentiment(db, 'test', { id: 'secret-id', text: 'We are hiring' }), false);
  assert.equal(db.prepare('SELECT count FROM sentiment_daily').get().count, 1);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM sentiment_seen').all()).includes('secret-id')); db.close();
});

test('HTTP rate limits block a host for the rest of the run; no bypass or retries', async () => {
  let calls = 0;
  const http = new Http(config.http, { sleepImpl: async () => {}, fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '120' } }); } });
  await assert.rejects(http.json('https://test.example/api'), /Rate limited/);
  await assert.rejects(http.json('https://test.example/other'), /cooling down/);
  assert.equal(calls, 1);
});

test('HTTP rejects oversized responses and does not retry paid POSTs', async () => {
  const http = new Http({ ...config.http, maxBytes: 2 }, { sleepImpl: async () => {}, fetchImpl: async () => new Response('large') });
  await assert.rejects(http.request('https://example.com'), /too large/);
  let calls = 0;
  const bad = new Http(config.http, { sleepImpl: async () => {}, fetchImpl: async () => { calls++; return new Response('', { status: 500 }); } });
  await assert.rejects(bad.json('https://example.com', { method: 'POST' }), /HTTP 500/);
  assert.equal(calls, 1);
});

test('all requested API adapters normalize their public response shapes', () => {
  const cases = {
    greenhouse: { jobs: [{ id: 1, title: 'Dev', location: { name: 'Remote' }, absolute_url: 'https://example.com' }] },
    lever: [{ id: '1', text: 'Dev', categories: { location: 'Remote' }, hostedUrl: 'https://example.com' }],
    ashby: { jobs: [{ id: '1', title: 'Dev', jobUrl: 'https://example.com' }] },
    workable: { jobs: [{ shortcode: 'a', title: 'Dev', url: 'https://example.com' }] },
    smartrecruiters: { content: [{ id: '1', name: 'Dev', company: { name: 'Example' } }] },
    adzuna: { results: [{ id: 1, title: 'Dev', company: { display_name: 'Example' } }] },
    usajobs: { SearchResult: { SearchResultItems: [{ MatchedObjectId: '1', MatchedObjectDescriptor: { PositionTitle: 'Dev', OrganizationName: 'Example' } }] } },
    arbeitnow: { data: [{ slug: 'a', title: 'Dev', company_name: 'Example' }] },
    himalayas: { jobs: [{ guid: '1', title: 'Dev', companyName: 'Example' }] },
    remotive: { jobs: [{ id: 1, title: 'Dev', company_name: 'Example' }] },
    remoteok: [{ legal: 'metadata' }, { id: '1', position: 'Dev', company: 'Example' }]
  };
  for (const [kind, fixture] of Object.entries(cases)) {
    const rows = normalizeJobs(kind, fixture, 'Example');
    assert.equal(rows.length, 1, kind); assert.equal(rows[0].title, 'Dev', kind); assert.equal(rows[0].company, 'Example', kind);
  }
});

test('restricted APIs and unapproved company boards stay off', () => {
  const sources = jobSources({ ...config.jobs, lever: ['example'], himalayas: { enabled: true }, remotive: { enabled: true } }, {});
  assert.equal(sources.find(s => s.name === 'lever:example').enabled, false);
  assert.equal(sources.find(s => s.name === 'himalayas').enabled, false);
  assert.equal(sources.find(s => s.name === 'remotive').enabled, false);
});

test('collector isolates failed sources, and reruns do not fetch successes twice', async () => {
  const db = openDb(':memory:'); let calls = 0;
  const sources = [
    { name: 'good', enabled: true, config: {}, collect: async () => { calls++; return [posting]; } },
    { name: 'bad', enabled: true, config: {}, collect: async () => { throw new Error('fixture failure'); } }
  ];
  assert.equal(await collectGroup(db, {}, config, 'jobs', sources, ingestPosting), 1);
  assert.equal(await collectGroup(db, {}, config, 'jobs', sources, ingestPosting), 1);
  assert.equal(calls, 1); db.close();
});

test('export has no invented cold-start metrics, listings, credentials or social text', () => {
  const db = openDb(':memory:'); taxonomy(db); const ids = demandFixture(db);
  for (const id of ids) tag(db, id);
  const out = buildExport(db, config, now);
  assert.equal(out.jobs[0].chg, 50); assert.equal(out.jobs[0].status, 'BOARDING');
  assert.equal(out.jobs[0].ai, null);
  assert.equal(out.jobs[0].history.length, 97);
  assert.equal(out.jobs[0].history.filter(p => p.count == null).length, 83);
  assert.ok(!JSON.stringify(out).includes(posting.description));
  assert.ok(!JSON.stringify(out).includes(posting.url));
  assert.equal(buildExport(openDb(':memory:'), config, now).jobs.length, 0); db.close();
});

test('pruning keeps tag cache and monthly budget history', () => {
  const db = openDb(':memory:'); taxonomy(db); ingestPosting(db, 'test', posting, '2025-01-01');
  tag(db, db.prepare('SELECT id FROM postings').get().id);
  reserveBudget(db, { monthlyUsd: 1 }, 100, now);
  prune(db, 210, now);
  assert.equal(db.prepare('SELECT count(*) n FROM postings').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM tags').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM budget').get().n, 1); db.close();
});

test('connected UI compiles and has no synthetic charts or live drift', () => {
  const html = readFileSync('site/index.html', 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.ok(script.includes("fetch('./jobs.json'"));
  assert.ok(!script.includes('function drift('));
  assert.ok(!script.includes('function seeded('));
  assert.ok(!script.includes('Large model release covers core tasks'));
  assert.ok(script.includes('if(chg==null) return UNKNOWN'));
});
