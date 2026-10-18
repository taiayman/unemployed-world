import { parse } from 'csv-parse/sync';
import { assert, normalize, hash } from './util.js';

const csv = raw => parse(raw, { columns: true, bom: true, skip_empty_lines: true });

export function importPublishedReference(db, occupations, tasks, jobExposure, taskPenetration, provenance) {
  assert(occupations.length && tasks.length && jobExposure.length && taskPenetration.length, 'Empty reference dataset');
  const byTask = new Map();
  for (const row of taskPenetration) {
    const score = Number(row.penetration);
    assert(row.task && row.penetration !== '' && Number.isFinite(score) && score >= 0 && score <= 1, 'Invalid task penetration schema');
    byTask.set(normalize(row.task), score);
  }
  const onet = JSON.stringify(provenance.onet), economic = JSON.stringify(provenance.economic);
  db.exec('BEGIN IMMEDIATE');
  try {
    // Reference replacement is atomic. Do not mix task/taxonomy releases.
    db.exec('DELETE FROM exposure; DELETE FROM task_penetration; DELETE FROM published_exposure; DELETE FROM tasks; DELETE FROM occupations;');
    for (const row of occupations) {
      assert(/^\d{2}-\d{4}\.\d{2}$/.test(row['O*NET-SOC Code']) && row.Title, 'Invalid O*NET occupation schema');
      db.prepare('INSERT INTO occupations VALUES(?,?,?)').run(row['O*NET-SOC Code'], row.Title, onet);
    }
    let matched = 0;
    for (const row of tasks) {
      const code = row['O*NET-SOC Code'], id = row['Task ID'];
      assert(/^\d+$/.test(id) && row.Task, 'Invalid O*NET task schema');
      db.prepare('INSERT INTO tasks VALUES(?,?,?,1)').run(code, id, row.Task);
      const score = byTask.get(normalize(row.Task));
      if (score != null) { db.prepare('INSERT INTO task_penetration VALUES(?,?,?,?)').run(code, id, score, economic); matched++; }
    }
    for (const row of jobExposure) {
      const score = Number(row.observed_exposure);
      assert(/^\d{2}-\d{4}$/.test(row.occ_code) && row.observed_exposure !== '' && Number.isFinite(score) && score >= 0 && score <= 1, 'Invalid published job exposure schema');
      db.prepare('INSERT INTO published_exposure VALUES(?,?,?)').run(row.occ_code, score, economic);
    }
    db.exec('COMMIT');
    return { occupations: occupations.length, tasks: tasks.length, matchedTasks: matched };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export async function refreshReference(db, http, config) {
  if (!config?.enabled) return { state: 'disabled' };
  assert(/^\d+\.\d+$/.test(config.onetVersion) && /^[a-f0-9]{40}$/.test(config.economicIndexRevision), 'Reference versions must be pinned');
  assert(config.onetBase.startsWith('https://www.onetcenter.org/dl_files/database/'), 'Expected official O*NET download URL');
  const key = hash(config);
  if (db.prepare("SELECT value FROM meta WHERE key='reference_version'").get()?.value === key) return { state: 'cached' };
  const occupationsRaw = await http.request(`${config.onetBase}occupation_data.csv`);
  const tasksRaw = await http.request(`${config.onetBase}task_statements.csv`);
  const base = `https://huggingface.co/datasets/Anthropic/EconomicIndex/resolve/${config.economicIndexRevision}/labor_market_impacts/`;
  const jobRaw = await http.request(`${base}job_exposure.csv`);
  const taskRaw = await http.request(`${base}task_penetration.csv`);
  const provenance = {
    onet: { url: 'https://www.onetcenter.org/database.html', version: config.onetVersion, license: 'CC BY 4.0',
      attribution: 'O*NET® is a trademark of USDOL/ETA. Modified for use here; no endorsement.', sha256: hash([occupationsRaw, tasksRaw]) },
    economic: { url: 'https://www.anthropic.com/research/labor-market-impacts', datasetUrl: base, version: config.economicIndexRevision,
      license: 'CC BY', attribution: 'Maxim Massenkoff and Peter McCrory, Anthropic (2026)',
      definition: 'Published observed exposure and task penetration, which incorporate capability, professional usage and automation weighting. Not a probability of job loss.', sha256: hash([jobRaw, taskRaw]) }
  };
  const result = importPublishedReference(db, csv(occupationsRaw), csv(tasksRaw), csv(jobRaw), csv(taskRaw), provenance);
  db.prepare("INSERT OR REPLACE INTO meta VALUES('reference_version',?)").run(key);
  return { state: 'imported', ...result };
}
