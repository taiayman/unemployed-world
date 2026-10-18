import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/pipeline.js';
import { assert, safeUrl } from '../src/util.js';

export const readTable = (path, delimiter = ',') => parse(readFileSync(path, 'utf8'), { columns: true, bom: true, skip_empty_lines: true, delimiter });

export function importOnet(db, occupations, tasks, provenance) {
  assert(safeUrl(provenance.url) && provenance.version, 'O*NET provenance needs a URL and dataset version');
  assert(occupations.length > 0 && tasks.length > 0, 'O*NET tables are empty');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of occupations) {
      const code = row['O*NET-SOC Code'], title = row.Title;
      assert(/^\d{2}-\d{4}\.\d{2}$/.test(code) && title, 'Invalid O*NET occupation');
      db.prepare('INSERT INTO occupations VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET title=excluded.title,provenance=excluded.provenance').run(code, title, JSON.stringify(provenance));
    }
    for (const row of tasks) {
      const code = row['O*NET-SOC Code'], id = row['Task ID'];
      assert(row.Task && /^\d+$/.test(id), 'Invalid O*NET task');
      const weight = Number(row.Weight || 1);
      assert(Number.isFinite(weight) && weight > 0, 'Task weight must be positive');
      db.prepare(`INSERT INTO tasks VALUES(?,?,?,?) ON CONFLICT(code,task_id) DO UPDATE SET description=excluded.description,weight=excluded.weight`)
        .run(code, id, row.Task, weight);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function importEconomicIndex(db, rows, provenance) {
  assert(safeUrl(provenance.url) && provenance.version && provenance.definition, 'Economic Index provenance needs URL, version, definition');
  assert(rows.length > 0, 'Economic Index table is empty');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) {
      const automation = Number(r.automation_share), augmentation = Number(r.augmentation_share);
      const usage = r.usage_share ? Number(r.usage_share) : null;
      assert(r.automation_share !== '' && r.augmentation_share !== '' && Number.isFinite(automation) && Number.isFinite(augmentation) && automation >= 0 && augmentation >= 0 && automation + augmentation <= 1.000001, 'Expected disjoint automation/augmentation fractions in [0,1], not percentages');
      assert(usage == null || Number.isFinite(usage) && usage >= 0 && usage <= 1, 'Invalid usage_share');
      // The FK rejects version-mismatched or invented O*NET task matches.
      db.prepare(`INSERT INTO exposure VALUES(?,?,?,?,?,?) ON CONFLICT(code,task_id) DO UPDATE SET automation=excluded.automation,
        augmentation=excluded.augmentation,usage_share=excluded.usage_share,provenance=excluded.provenance`)
        .run(r.onet_code, r.task_id, automation, augmentation, usage, JSON.stringify(provenance));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function main() {
  const [kind, first, second, third] = process.argv.slice(2), config = loadConfig();
  const db = openDb(config.database);
  try {
    if (kind === 'onet') importOnet(db, readTable(first, '\t'), readTable(second, '\t'), JSON.parse(readFileSync(third, 'utf8')));
    else if (kind === 'economic-index') importEconomicIndex(db, readTable(first), JSON.parse(readFileSync(second, 'utf8')));
    else throw new Error('Usage: npm run import -- onet "Occupation Data.txt" "Task Statements.txt" provenance.json | economic-index normalized.csv provenance.json');
    console.log('Imported exposure reference data into SQLite');
  } finally { db.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
