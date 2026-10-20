import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { openDb, ingestPosting, prune } from '../src/db.js';
import { canonicalUrl } from '../src/util.js';
import { flightStatus, exposureScore, buildExport, readWeekly, weeklyChange, socialScore, validateSocialRow, validateCapabilityRow } from '../src/metrics.js';
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
test('dedupe cross-source by normalized tuple, URL, and native id ', () => {
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

test('status boundaries match the supplied UI', () => {
  assert.deepEqual([null, -30, -29, -18, -17, -8, -7, 7, 8].map(flightStatus), [null, 'CANCELLED', 'FINAL CALL', 'FINAL CALL', 'DELAYED', 'DELAYED', 'ON TIME', 'ON TIME', 'BOARDING']);
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

test('weekly manual data: stated baseline, ~13-week lookup, mean across sources, and rejects bad rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weekly-'));
  const row = (o) => JSON.stringify({ onet: '15-1252.00', source: 'A', url: 'https://a.test/x', metric: 'postings', ...o });
  try {
    writeFileSync(join(dir, '2026-07-20.jsonl'), row({ value: 100, asOf: '2026-07-18' }) + '\n');
    writeFileSync(join(dir, '2026-10-19.jsonl'), [row({ value: 80, asOf: '2026-10-17' }),
      row({ source: 'B', value: 130, asOf: '2026-10-16', baselineValue: 100, baselineAsOf: '2026-07-18' }),
      row({ onet: '29-1141.00', value: 5, asOf: '2026-10-17' })].join('\n') + '\n');
    const weeks = readWeekly(dir);
    const d = weeklyChange(weeks, '15-1252.00');
    assert.deepEqual(d.sources.map(s => s.change), [-20, 30]);
    assert.equal(d.change, 5); assert.equal(d.state, 'measured');
    assert.equal(weeklyChange(weeks, '29-1141.00').change, null);
    const db = openDb(':memory:'); taxonomy(db);
    const out = buildExport(db, config, weeks, now);
    assert.equal(out.jobs.length, 1); assert.equal(out.jobs[0].chg, 5); assert.equal(out.jobs[0].status, 'ON TIME');
    assert.equal(buildExport(openDb(':memory:'), config, [], now).jobs.length, 0); db.close();
    for (const bad of [row({ value: -1, asOf: '2026-10-17' }), row({ value: 1, asOf: '2026-01-01' }), row({ value: 1, asOf: '2026-10-17', url: 'http://a.test' }),
      row({ value: 1, asOf: '2026-10-17', baselineValue: 1, baselineAsOf: '2026-10-01' }), row({ onet: '151252', value: 1, asOf: '2026-10-17' }), '{oops']) {
      writeFileSync(join(dir, '2026-10-19.jsonl'), bad + '\n');
      assert.throws(() => readWeekly(dir), /2026-10-19\.jsonl:1/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pruning drops expired postings', () => {
  const db = openDb(':memory:'); ingestPosting(db, 'test', posting, '2025-01-01');
  prune(db, 210, now);
  assert.equal(db.prepare('SELECT count(*) n FROM postings').get().n, 0); db.close();
});

test('connected UI compiles and has no synthetic charts or live drift', () => {
  const html = readFileSync('site/index.html', 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.ok(script.includes("fetch('./jobs.json'"));
  assert.ok(!script.includes('function drift('));
  assert.ok(!script.includes('function seeded('));
  assert.ok(!script.includes('Large model release covers core tasks'));
  // Unknown demand and exposure are exercised against the rendered UI in ui.test.js.
});

test('social score: net of growth vs decline across platforms, null below 3 opinions, ads not scored', () => {
  const rows = [{ onet: '15-1252.00', platform: 'X', query: 'q', sampled: 30, jobAds: 5, decline: 3, growth: 1, asOf: '2026-10-20' },
    { onet: '15-1252.00', platform: 'LinkedIn', query: 'q', sampled: 30, jobAds: 20, decline: 2, growth: 0, asOf: '2026-10-20' },
    { onet: '29-1141.00', platform: 'X', query: 'q', sampled: 30, jobAds: 0, decline: 1, growth: 1, asOf: '2026-10-20' }];
  for (const r of rows) validateSocialRow(r, '2026-10-19', 'x');
  const social = [{ week: '2026-10-19', rows }];
  const s = socialScore(social, '15-1252.00');
  assert.equal(s.score, -67); assert.equal(s.jobAds, 25); assert.equal(s.platforms.length, 2);
  assert.equal(socialScore(social, '29-1141.00').score, null);
  assert.equal(socialScore(social, '13-2011.00'), null);
  assert.throws(() => validateSocialRow({ ...rows[0], decline: 30 }, '2026-10-19', 'x'), /exceed/);
  const cap = { onet: '15-1252.00', benchmark: 'b', leader: 'l', url: 'https://a.test', score: 68, max: 100, asOf: '2026-10-20' };
  validateCapabilityRow(cap, '2026-10-19', 'x');
  assert.throws(() => validateCapabilityRow({ ...cap, score: 120 }, '2026-10-19', 'x'), /between/);
});
