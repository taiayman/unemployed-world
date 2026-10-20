import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const html = readFileSync('site/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
async function render(payload, ok = true) {
  const { document } = parseHTML(html);
  await vm.runInNewContext(script, {
    document, window: { matchMedia: () => ({ matches: true }) }, matchMedia: () => ({ matches: true }),
    fetch: async () => ({ ok, status: ok ? 200 : 503, json: async () => payload }),
    getComputedStyle: () => ({ getPropertyValue: () => '18' }),
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
    ResizeObserver: class { observe() {} }, navigator: {}, console, Date
  });
  return document;
}
const payload = { schemaVersion: 1, generatedAt: new Date().toISOString(), news: [], jobs: [{
  id: '15-1252.00', code: '15 125', name: 'SOFTWARE DEVELOPERS', short: 'SOFTWARE DEV', chg: null, ai: null,
  activeSample: 5, exposure: { taskCoverage: 0, evidence: [] }, history: []
}] };

test('UI renders unknown demand and risk without falling back to sample figures', async () => {
  const doc = await render(payload);
  assert.equal(doc.querySelectorAll('.row').length, 1);
  assert.ok(doc.querySelector('.stamp').textContent.includes('COLLECTING'));
  assert.ok(doc.querySelector('#pass').textContent.includes('Unknown'));
  assert.equal(doc.querySelector('.chartbox'), null);
  assert.ok(!doc.querySelector('#pass').textContent.includes('sample'));
});

test('UI handles empty and failed feeds without fabricated board rows', async () => {
  const empty = await render({ ...payload, jobs: [] });
  assert.equal(empty.querySelectorAll('.row').length, 0);
  assert.ok(empty.querySelector('#hint').textContent.includes('Collecting postings'));
  const failed = await render(null, false);
  assert.ok(failed.querySelector('#hint').textContent.includes('unavailable'));
});

test('UI escapes external names and evidence and uses observed history', async () => {
  const data = structuredClone(payload);
  Object.assign(data.jobs[0], { name: '<img src=x onerror=alert(1)>', chg: 20, ai: 50,
    history: [{ date: '2026-10-17', count: 5 }, { date: '2026-10-18', count: 6 }] });
  data.jobs[0].exposure.evidence.push({ attribution: '<script>alert(1)</script>' });
  const doc = await render(data);
  assert.equal(doc.querySelector('#pass img'), null);
  assert.equal(doc.querySelector('#pass script'), null);
  assert.ok(doc.querySelector('.stamp').textContent.includes('BOARDING'));
  assert.ok(doc.querySelector('.chartbox svg'));
});
