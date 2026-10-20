import test from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../src/http.js';
import { loadConfig } from '../src/pipeline.js';
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
