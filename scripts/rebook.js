// Builds data/rebook.json: skill match between every pair of board jobs, from O*NET
// importance ratings (transferable skills, knowledge, work activities). Run when the
// board list or the O*NET version changes: node scripts/rebook.js
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';

const config = JSON.parse(readFileSync('config/pipeline.json', 'utf8'));
const board = JSON.parse(readFileSync(config.board, 'utf8'));
const codes = board.rows.map(r => r.onet);

const vectors = new Map(codes.map(c => [c, new Map()]));
const all = new Map(); // element -> values across every occupation, for centering
for (const file of ['transferable_skills', 'knowledge', 'work_activities']) {
  // ONET_DIR=path reads already-downloaded CSVs instead of fetching them.
  const text = process.env.ONET_DIR ? readFileSync(`${process.env.ONET_DIR}/${file}.csv`, 'utf8')
    : await fetch(`${config.reference.onetBase}${file}.csv`).then(res => { if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`); return res.text(); });
  for (const r of parse(text, { columns: true, bom: true })) {
    if (r['Scale ID'] !== 'IM') continue;
    const key = `${file}:${r['Element ID']}`, v = Number(r['Data Value']);
    if (!Number.isFinite(v)) continue;
    if (!all.has(key)) all.set(key, []);
    all.get(key).push(v);
    vectors.get(r['O*NET-SOC Code'])?.set(key, v);
  }
}
const mean = new Map([...all].map(([k, vs]) => [k, vs.reduce((a, b) => a + b, 0) / vs.length]));
const thin = codes.filter(c => vectors.get(c).size < 50);
if (thin.length) throw new Error(`Too few O*NET ratings for ${thin.join(", ")}`);

// Pearson-style correlation of centered importance profiles; negative counts as 0% match.
function match(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, m] of mean) {
    const x = (vectors.get(a).get(k) ?? m) - m, y = (vectors.get(b).get(k) ?? m) - m;
    dot += x * y; na += x * x; nb += y * y;
  }
  return Math.max(0, Math.round(100 * dot / Math.sqrt(na * nb)));
}

const out = {};
for (const a of codes) out[a] = codes.filter(b => b !== a).map(b => [b, match(a, b)]).sort((x, y) => y[1] - x[1]);
writeFileSync('data/rebook.json', JSON.stringify({ source: `O*NET ${config.reference.onetVersion} transferable skills, knowledge and work activities (importance)`, matches: out }) + '\n');
console.log('wrote data/rebook.json for', codes.length, 'jobs');
