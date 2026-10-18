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

// Compare 7-day posting-observation averages ending today and 90 days ago.
// Only same-configuration source-days successful in BOTH windows contribute.
// Missing pages and outages are never zeros; changes to the source mix block
// an aggregate comparison instead of manufacturing a hiring collapse.
export function demandChange(db, postingIds, config, now = new Date()) {
  const result = { change: null, state: 'collecting_history', baseline: null, current: null, matchedDays: 0, sources: [] };
  const currentDays = Array.from({ length: 7 }, (_, i) => ago(6 - i, now));
  const baselineDays = Array.from({ length: 7 }, (_, i) => ago(96 - i, now));
  const runs = db.prepare('SELECT * FROM source_runs WHERE day>=? AND day<=?').all(baselineDays[0], day(now));
  const byKey = new Map(runs.map(r => [`${r.day}/${r.source}`, r]));
  const sources = [...new Set(runs.filter(r => currentDays.includes(r.day) && r.source.startsWith('jobs:')).map(r => r.source))].sort();
  const paired = [];
  for (let i = 0; i < 7; i++) {
    const common = sources.filter(source => {
      const a = byKey.get(`${currentDays[i]}/${source}`), b = byKey.get(`${baselineDays[i]}/${source}`);
      return a?.status === 'ok' && b?.status === 'ok' && a.config_hash === b.config_hash;
    });
    if (common.length) paired.push({ current: currentDays[i], baseline: baselineDays[i], sources: common });
  }
  result.matchedDays = paired.length;
  if (paired.length < config.minMatchedDays) return result;
  const wanted = new Set(postingIds);
  const observations = db.prepare('SELECT day,source,posting_id FROM observations WHERE (day BETWEEN ? AND ?) OR (day BETWEEN ? AND ?)')
    .all(currentDays[0], currentDays[6], baselineDays[0], baselineDays[6]);
  const sourceTotals = new Map();
  for (const r of observations) {
    const key = `${r.day}/jobs:${r.source}`;
    if (!sourceTotals.has(key)) sourceTotals.set(key, new Set());
    sourceTotals.get(key).add(r.posting_id);
  }
  // A large shift in market-wide source shares is evidence of sampling drift.
  const totals = { current: new Map(), baseline: new Map() };
  for (const p of paired) for (const side of ['current', 'baseline']) for (const s of p.sources) totals[side].set(s, (totals[side].get(s) || 0) + (sourceTotals.get(`${p[side]}/${s}`)?.size || 0));
  const sums = Object.fromEntries(Object.entries(totals).map(([k, m]) => [k, [...m.values()].reduce((a, b) => a + b, 0)]));
  if (!sums.baseline) { result.state = 'insufficient_baseline'; return result; }
  const allSources = [...new Set(paired.flatMap(p => p.sources))];
  if (allSources.some(s => Math.abs((totals.current.get(s) || 0) / (sums.current || 1) - (totals.baseline.get(s) || 0) / (sums.baseline || 1)) > config.maxSourceShareShift)) {
    result.state = 'source_mix_changed'; return result;
  }
  let current = 0, baseline = 0;
  const points = [];
  for (const pair of paired) {
    const values = {};
    for (const side of ['current', 'baseline']) {
      const ids = new Set(observations.filter(o => o.day === pair[side] && pair.sources.includes(`jobs:${o.source}`) && wanted.has(o.posting_id)).map(o => o.posting_id));
      values[side] = ids.size;
    }
    current += values.current; baseline += values.baseline;
    points.push({ date: pair.current, count: values.current, baselineDate: pair.baseline, baselineCount: values.baseline });
  }
  result.current = Math.round(current / paired.length * 100) / 100;
  result.baseline = Math.round(baseline / paired.length * 100) / 100;
  result.sources = allSources.map(s => s.replace(/^jobs:/, ''));
  result.points = points;
  if (baseline / paired.length < config.minBaselineCount) { result.state = 'insufficient_baseline'; return result; }
  result.change = Math.round((current - baseline) / baseline * 100);
  result.state = 'measured';
  return result;
}

export function buildExport(db, config, now = new Date()) {
  const date = day(now);
  const tagged = db.prepare(`SELECT p.*,t.result FROM postings p JOIN tags t ON p.content_hash=t.content_hash
    AND t.version=? AND t.model=? WHERE p.last_seen>=?`).all(config.llm.promptVersion, config.llm.model, ago(200, now));
  const groups = new Map();
  for (const p of tagged) {
    const tag = JSON.parse(p.result);
    if (!tag.onet || tag.confidence < 0.6) continue;
    if (!groups.has(tag.onet)) groups.set(tag.onet, []);
    groups.get(tag.onet).push({ ...p, tag });
  }
  const jobs = [];
  const allObservations = db.prepare('SELECT * FROM observations WHERE day>=?').all(ago(96, now));
  const successfulRuns = new Set(db.prepare("SELECT day,source FROM source_runs WHERE status='ok' AND day>=?").all(ago(96, now)).map(r => `${r.day}/${r.source}`));
  // Index once, rather than scanning 97 days of observations for every row
  // and chart point. This keeps a 210-day daily pipeline cheap to export.
  const occupationForPosting = new Map([...groups].flatMap(([code, posts]) => posts.map(p => [p.id, code])));
  const historyIndex = new Map();
  for (const observation of allObservations) {
    const code = occupationForPosting.get(observation.posting_id);
    if (!code) continue;
    const key = `${code}/${observation.day}/${observation.source}`;
    if (!historyIndex.has(key)) historyIndex.set(key, new Set());
    historyIndex.get(key).add(observation.posting_id);
  }
  const todayPanel = [...new Set(allObservations.filter(o => o.day === date).map(o => o.source))];
  for (const [code, posts] of groups) {
    const occupation = db.prepare('SELECT * FROM occupations WHERE code=?').get(code);
    if (!occupation) continue;
    const demand = demandChange(db, posts.map(p => p.id), config.metrics, now);
    const exposure = exposureScore(db, code);
    const skills = new Map();
    for (const p of posts.filter(p => p.last_seen >= ago(7, now))) for (const s of p.tag.skills) skills.set(s, (skills.get(s) || 0) + 1);
    const panel = demand.sources.length ? demand.sources : todayPanel;
    const history = Array.from({ length: 97 }, (_, i) => {
      const d = ago(96 - i, now);
      const complete = panel.length > 0 && panel.every(s => successfulRuns.has(`${d}/jobs:${s}`));
      const ids = new Set();
      if (complete) for (const s of panel) for (const id of historyIndex.get(`${code}/${d}/${s}`) || []) ids.add(id);
      return { date: d, count: complete ? ids.size : null };
    });
    jobs.push({ id: code, code: `${code.slice(0, 2)} ${code.slice(3, 6)}`, name: occupation.title.toUpperCase(), short: occupation.title.toUpperCase().slice(0, 13),
      chg: demand.change, ai: exposure.score, status: flightStatus(demand.change), demand, exposure,
      activeSample: posts.filter(p => p.last_seen >= ago(7, now)).length,
      skills: [...skills].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([s]) => s),
      tags: { seniority: [...new Set(posts.map(p => p.tag.seniority))], remote: [...new Set(posts.map(p => p.tag.remote))] },
      evidence: [{ title: 'O*NET occupation and tasks', url: JSON.parse(occupation.provenance).url }],
      history, historySources: panel });
  }
  jobs.sort((a, b) => (a.chg ?? 0) - (b.chg ?? 0) || a.id.localeCompare(b.id));
  const counts = db.prepare('SELECT COUNT(*) total FROM postings').get();
  const taggedCount = db.prepare('SELECT COUNT(*) total FROM postings p WHERE EXISTS(SELECT 1 FROM tags t WHERE t.content_hash=p.content_hash AND t.version=? AND t.model=?)').get(config.llm.promptVersion, config.llm.model).total;
  const month = date.slice(0, 7);
  const budget = db.prepare('SELECT COALESCE(SUM(reserved_micros),0) reserved,COALESCE(SUM(actual_micros),0) reported FROM budget WHERE month=?').get(month);
  return { schemaVersion: 1, generatedAt: now.toISOString(),
    methodology: {
      demand: 'Percent change in average daily unique observed postings, 7-day windows 90 days apart; matched source/configuration/day pairs only. Bounded samples, not the whole job market.',
      risk: 'Published Anthropic observed exposure for exact SOC6 .00 occupations; otherwise matched O*NET task penetration mean (50% coverage required). Optional normalized task imports use automation + half augmentation. Not replacement probability or evidence of causation.',
      statuses: { BOARDING: '>= +8%', 'ON TIME': '-7% to +7%', DELAYED: '-17% to -8%', 'FINAL CALL': '-29% to -18%', CANCELLED: '<= -30%' },
      sentiment: 'English keyword lexicon with local negation, bounded non-representative samples. No social text or identities exported. Does not change demand or risk.',
      news: 'Lab feed entries, model popularity and research papers are context, not verified release events or causes of hiring changes.' },
    coverage: { postings: counts.total, taggedPostings: taggedCount, untaggedPostings: counts.total - taggedCount,
      taxonomy: db.prepare('SELECT COUNT(*) total FROM occupations').get().total,
      exposureTasks: db.prepare('SELECT (SELECT COUNT(*) FROM exposure)+(SELECT COUNT(*) FROM task_penetration) total').get().total },
    budget: { month, capUsd: config.llm.monthlyUsd, reservedUsd: budget.reserved / 1000000, reportedUsd: budget.reported / 1000000,
      basis: 'Conservative reservations are never refunded, including failed calls. Provider-side dedicated-key limit is also required.' },
    sources: db.prepare('SELECT source,status,count,detail FROM source_runs WHERE day=? ORDER BY source').all(date),
    jobs,
    news: db.prepare('SELECT source,title,url,published_at AS publishedAt,first_seen AS firstSeen FROM news WHERE last_seen>=? ORDER BY COALESCE(published_at,first_seen) DESC LIMIT 50').all(ago(14, now)),
    sentiment: db.prepare('SELECT day,source,count,ROUND(score_sum/count,3) score FROM sentiment_daily WHERE day>=? ORDER BY day DESC,source').all(ago(7, now)),
    provenanceHash: hash(config) };
}
