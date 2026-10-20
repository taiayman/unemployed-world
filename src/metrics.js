import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ago, day, hash } from './util.js';

export function flightStatus(change) {
  if (change == null) return null;
  if (change <= -30) return 'CANCELLED';
  if (change <= -18) return 'FINAL CALL';
  if (change <= -8) return 'DELAYED';
  if (change < 8) return 'ON TIME';
  return 'BOARDING';
}

export function exposureScore(db, code) {
  const penetration = db.prepare(`SELECT t.weight,p.score,p.provenance FROM tasks t
    LEFT JOIN task_penetration p USING(code,task_id) WHERE t.code=?`).all(code);
  const published = code.endsWith('.00') ? db.prepare('SELECT * FROM published_exposure WHERE soc=?').get(code.slice(0, 7)) : null;
  const matched = penetration.filter(p => p.score != null);
  if (published || matched.length) {
    const totalWeight = penetration.reduce((s, r) => s + r.weight, 0);
    const knownWeight = matched.reduce((s, r) => s + r.weight, 0);
    const coverage = totalWeight ? knownWeight / totalWeight : 0;
    return {
      score: published ? Math.round(100 * published.score) : coverage >= 0.5 ? Math.round(100 * matched.reduce((s, r) => s + r.weight * r.score, 0) / knownWeight) : null,
      taskCoverage: Math.round(coverage * 1000) / 1000, knownTasks: matched.length, totalTasks: penetration.length,
      method: published ? 'Published Anthropic observed exposure × 100 (SOC6 .00 match); task matching coverage reported separately' : 'Equal-weight mean of exact normalized O*NET task matches to published Anthropic task penetration; null below 50% task coverage',
      evidence: [...new Set([...(published ? [published.provenance] : []), ...matched.map(p => p.provenance)])].map(p => JSON.parse(p))
    };
  }
  const rows = db.prepare(`SELECT t.weight,e.automation,e.augmentation,e.usage_share,e.provenance
    FROM tasks t LEFT JOIN exposure e USING(code,task_id) WHERE t.code=?`).all(code);
  const total = rows.reduce((s, r) => s + r.weight, 0);
  const known = rows.filter(r => r.automation != null);
  const covered = known.reduce((s, r) => s + r.weight, 0);
  return {
    score: covered && covered / total >= 0.5 ? Math.round(100 * known.reduce((s, r) => s + r.weight * (r.automation + 0.5 * r.augmentation), 0) / covered) : null,
    taskCoverage: total ? Math.round(100 * covered / total) / 100 : 0,
    knownTasks: known.length, totalTasks: rows.length,
    method: 'Weighted observed automation + 0.5 × augmentation share; proxy, not probability of replacement',
    evidence: [...new Set(known.map(r => r.provenance))].map(p => JSON.parse(p))
  };
}

const daysBetween = (a, b) => (Date.parse(a) - Date.parse(b)) / 86400000;
const isoDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

// Manual weekly entries live in data/weekly/YYYY-MM-DD.jsonl, one gathered figure
// per line. A bad row throws so a typo never reaches the public export.
export function validateRow(r, week, where) {
  const fail = why => { throw new Error(`${where}: ${why}`); };
  if (!r || typeof r !== 'object') fail('not an object');
  if (!/^\d{2}-\d{4}\.\d{2}$/.test(r.onet)) fail('onet must look like 15-1252.00');
  for (const k of ['source', 'metric']) if (typeof r[k] !== 'string' || !r[k].trim() || r[k].length > 120) fail(`bad ${k}`);
  if (typeof r.url !== 'string' || !/^https:\/\/\S+$/.test(r.url)) fail('url must be https');
  if (!Number.isFinite(r.value) || r.value < 0) fail('value must be a number >= 0');
  if (!isoDate(r.asOf)) fail('asOf must be YYYY-MM-DD');
  const age = daysBetween(week, r.asOf);
  if (age < -1 || age > 14) fail(`asOf ${r.asOf} is not within 14 days of week ${week}`);
  if (r.baselineKind != null && !['peak', 'since'].includes(r.baselineKind)) fail('baselineKind may only be "peak" or "since"');
  if (r.baselineValue != null || r.baselineAsOf != null) {
    if (!Number.isFinite(r.baselineValue) || r.baselineValue < 0) fail('baselineValue must be a number >= 0');
    if (!isoDate(r.baselineAsOf)) fail('baselineAsOf must be YYYY-MM-DD');
    const gap = daysBetween(r.asOf, r.baselineAsOf);
    if (r.baselineKind === 'peak' ? gap < 0 || r.baselineValue < r.value : r.baselineKind === 'since' ? gap <= 0 : gap < 76 || gap > 106)
      fail(r.baselineKind === 'peak' ? 'peak baseline must be on or before asOf and >= value' : r.baselineKind === 'since' ? 'baselineAsOf must be before asOf' : 'baselineAsOf must be about 90 days (76-106) before asOf');
  }
}

export function readWeekly(dir, validate = validateRow) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().map(file => {
    const week = file.slice(0, 10), rows = [];
    readFileSync(join(dir, file), 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      let row;
      try { row = JSON.parse(line); } catch { throw new Error(`${file}:${i + 1}: not valid JSON`); }
      validate(row, week, `${file}:${i + 1}`);
      rows.push(row);
    });
    return { week, rows };
  });
}

// Manual social scan: posts read per occupation and platform, each counted as a
// job ad, "decline" (says the job is shrinking or being replaced), "growth"
// (says it is safe or growing) or neither.
export function validateSocialRow(r, week, where) {
  const fail = why => { throw new Error(`${where}: ${why}`); };
  if (!r || typeof r !== 'object') fail('not an object');
  if (!/^\d{2}-\d{4}\.\d{2}$/.test(r.onet)) fail('onet must look like 15-1252.00');
  for (const k of ['platform', 'query']) if (typeof r[k] !== 'string' || !r[k].trim() || r[k].length > 300) fail(`bad ${k}`);
  for (const k of ['sampled', 'jobAds', 'decline', 'growth']) if (!Number.isInteger(r[k]) || r[k] < 0) fail(`${k} must be an integer >= 0`);
  if (r.jobAds + r.decline + r.growth > r.sampled) fail('jobAds + decline + growth exceed sampled');
  if (!isoDate(r.asOf)) fail('asOf must be YYYY-MM-DD');
  const age = daysBetween(week, r.asOf);
  if (age < -7 || age > 14) fail(`asOf ${r.asOf} is not within the week ${week}`);
}

// Net social score = (growth - decline) / (growth + decline) x 100 across platforms;
// null below 3 opinion posts. Job ads are reported but not scored (many are bots).
export function socialScore(social, code) {
  const rows = (social.at(-1)?.rows || []).filter(r => r.onet === code);
  if (!rows.length) return null;
  const sum = k => rows.reduce((n, r) => n + r[k], 0);
  const decline = sum('decline'), growth = sum('growth'), opinions = decline + growth;
  return { score: opinions >= 3 ? Math.round(100 * (growth - decline) / opinions) : null,
    decline, growth, jobAds: sum('jobAds'), sampled: sum('sampled'), week: social.at(-1).week,
    platforms: rows.map(({ platform, query, sampled, jobAds, decline, growth, asOf }) => ({ platform, query, sampled, jobAds, decline, growth, asOf })) };
}

// Manual AI-capability figures: a published benchmark score for AI on this job's work.
export function validateCapabilityRow(r, week, where) {
  const fail = why => { throw new Error(`${where}: ${why}`); };
  if (!r || typeof r !== 'object') fail('not an object');
  if (!/^\d{2}-\d{4}\.\d{2}$/.test(r.onet)) fail('onet must look like 15-1252.00');
  for (const k of ['benchmark', 'leader']) if (typeof r[k] !== 'string' || !r[k].trim() || r[k].length > 300) fail(`bad ${k}`);
  if (typeof r.url !== 'string' || !/^https:\/\/\S+$/.test(r.url)) fail('url must be https');
  if (!Number.isFinite(r.max) || r.max <= 0 || !Number.isFinite(r.score) || r.score < 0 || r.score > r.max) fail('score must be between 0 and max');
  if (!isoDate(r.asOf)) fail('asOf must be YYYY-MM-DD');
  const age = daysBetween(week, r.asOf);
  if (age < -7 || age > 14) fail(`asOf ${r.asOf} is not within the week ${week}`);
}

// Per source: latest value vs its stated ~90-day baseline, or vs the same
// source+metric entered ~13 weeks earlier. Occupation change = mean across sources.
export function weeklyChange(weeks, code) {
  const latest = weeks.at(-1);
  const earlier = weeks.flatMap(w => w.rows);
  const sources = (latest?.rows || []).filter(r => r.onet === code).map(r => {
    let baselineValue = r.baselineValue ?? null, baselineAsOf = r.baselineAsOf ?? null;
    if (baselineValue == null) {
      const old = earlier.find(o => o.onet === code && o.source === r.source && o.metric === r.metric && Math.abs(daysBetween(r.asOf, o.asOf) - 91) <= 15);
      if (old) ({ value: baselineValue, asOf: baselineAsOf } = old);
    }
    const ratio = baselineValue > 0 ? (r.value - baselineValue) / baselineValue : null;
    return { source: r.source, url: r.url, metric: r.metric, value: r.value, asOf: r.asOf, baselineValue, baselineAsOf, baselineKind: r.baselineKind ?? '90d', ratio };
  });
  const known = sources.filter(s => s.ratio != null);
  return {
    change: known.length ? Math.round(100 * known.reduce((sum, s) => sum + s.ratio, 0) / known.length) : null,
    state: known.length ? 'measured' : sources.length ? 'collecting_history' : 'no_data',
    week: latest?.week ?? null,
    sources: sources.map(({ ratio, ...s }) => ({ ...s, change: ratio == null ? null : Math.round(100 * ratio) }))
  };
}

// Board names must fit 20 flaps (13 on phones): cut at the first comma or " AND ",
// then use a hand-written short name from data/display-names.json if still too long.
const ABBR = { DEVELOPERS: 'DEVS', ENGINEERS: 'ENGRS', SPECIALISTS: 'SPECS', TECHNICIANS: 'TECHS', MANAGERS: 'MGRS', ASSISTANTS: 'ASSTS', REPRESENTATIVES: 'REPS', ADMINISTRATORS: 'ADMINS', OPERATORS: 'OPS', ANALYSTS: 'ANALYSTS' };
export function boardNames(title, override) {
  let name = title.toUpperCase().split(',')[0].trim();
  if (name.length > 20) name = name.split(' AND ')[0].trim();
  if (override) name = override;
  if (name.length > 20) name = name.slice(0, 20).trim();
  let words = name.split(' ').map(w => w.length > 6 && ABBR[w] ? ABBR[w] : w);
  while (words.length > 1 && words.join(' ').length > 13) words.pop();
  return { name, short: words.join(' ').slice(0, 13) };
}

// Optional curated board (data/board.json): one row per posting category, with its own
// name, plus the whole-market change the board compares every row against.
export function boardMarket(board) {
  const m = board?.market;
  return m ? { ...m, change: Math.round(100 * (m.value - m.baselineValue) / m.baselineValue), since: board.since } : null;
}

export function buildExport(db, config, weeks = [], now = new Date(), social = [], capability = [], displayNames = {}, board = null, rebook = null) {
  const date = day(now);
  const jobs = [];
  const boardRows = board ? new Map(board.rows.map(r => [r.onet, r])) : null;
  const codes = boardRows ? [...boardRows.keys()] : new Set((weeks.at(-1)?.rows || []).map(r => r.onet));
  for (const code of codes) {
    const occupation = db.prepare('SELECT * FROM occupations WHERE code=?').get(code);
    if (!occupation) { console.warn(`Weekly data: unknown O*NET code ${code}, skipped`); continue; }
    const demand = weeklyChange(weeks, code), exposure = exposureScore(db, code);
    const { name, short } = boardNames(occupation.title, boardRows?.get(code)?.name ?? displayNames[code]);
    jobs.push({ id: code, code: `${code.slice(0, 2)} ${code.slice(3, 6)}`, name, short, title: occupation.title,
      chg: demand.change, ai: exposure.score, status: flightStatus(demand.change), demand, exposure, social: socialScore(social, code),
      capability: (capability.at(-1)?.rows || []).find(r => r.onet === code) ?? null,
      rebook: rebook?.matches?.[code]?.map(([id, match]) => ({ id, match })) ?? [],
      evidence: [{ title: 'O*NET occupation and tasks', url: JSON.parse(occupation.provenance).url }, ...demand.sources.map(s => ({ title: s.source, url: s.url }))],
      history: [] });
  }
  jobs.sort((a, b) => (a.chg ?? 0) - (b.chg ?? 0) || a.id.localeCompare(b.id));
  return { schemaVersion: 1, generatedAt: now.toISOString(),
    methodology: {
      demand: 'Job postings now vs 30 Nov 2022, when ChatGPT launched (Indeed Hiring Lab US posting index per job category). market is the same change for all US jobs; the board status compares each row with it. Every figure links to its source.',
      risk: 'Published Anthropic observed exposure for exact SOC6 .00 occupations; otherwise matched O*NET task penetration mean (50% coverage required). Optional normalized task imports use automation + half augmentation. Not replacement probability or evidence of causation.',
      statuses: { BOARDING: '>= +8%', 'ON TIME': '-7% to +7%', DELAYED: '-17% to -8%', 'FINAL CALL': '-29% to -18%', CANCELLED: '<= -30%' },
      sentiment: 'English keyword lexicon with local negation, bounded non-representative samples. No social text or identities exported. Does not change demand or risk.',
      capability: 'Published AI benchmark scores on the work this job does (for example AI coding agents on real software-engineering tasks). Shows what AI can do, not what it is used for; never mixed into demand or risk.',
      social: 'Weekly manual read of recent X/LinkedIn posts per occupation. Each post is counted as a job ad, decline (job shrinking or replaced), growth (job safe or growing) or neither. Score = (growth - decline) / (growth + decline) x 100, null below 3 opinion posts. Small, non-representative samples; shown separately and never mixed into demand or risk.',
      news: 'Lab feed entries, model popularity and research papers are context, not verified release events or causes of hiring changes.' },
    coverage: { occupations: jobs.length, week: weeks.at(-1)?.week ?? null,
      postings: db.prepare('SELECT COUNT(*) total FROM postings').get().total,
      taxonomy: db.prepare('SELECT COUNT(*) total FROM occupations').get().total,
      exposureTasks: db.prepare('SELECT (SELECT COUNT(*) FROM exposure)+(SELECT COUNT(*) FROM task_penetration) total').get().total },
    market: boardMarket(board),
    sources: db.prepare('SELECT source,status,count,detail FROM source_runs WHERE day=? ORDER BY source').all(date),
    jobs,
    news: db.prepare('SELECT source,title,url,published_at AS publishedAt,first_seen AS firstSeen FROM news WHERE last_seen>=? ORDER BY COALESCE(published_at,first_seen) DESC LIMIT 50').all(ago(14, now)),
    sentiment: db.prepare('SELECT day,source,count,ROUND(score_sum/count,3) score FROM sentiment_daily WHERE day>=? ORDER BY day DESC,source').all(ago(7, now)),
    provenanceHash: hash(config) };
}
