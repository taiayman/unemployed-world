import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalUrl, hash, normalize, text, day, ago } from './util.js';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS postings(
      id TEXT PRIMARY KEY, title TEXT NOT NULL, company TEXT NOT NULL, location TEXT NOT NULL,
      url TEXT, description TEXT NOT NULL, content_hash TEXT NOT NULL,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, published_at TEXT);
    CREATE TABLE IF NOT EXISTS identities(identity TEXT PRIMARY KEY,posting_id TEXT NOT NULL REFERENCES postings(id));
    CREATE TABLE IF NOT EXISTS observations(day TEXT NOT NULL,source TEXT NOT NULL,posting_id TEXT NOT NULL REFERENCES postings(id),
      PRIMARY KEY(day,source,posting_id));
    CREATE TABLE IF NOT EXISTS source_runs(day TEXT NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL,
      count INTEGER NOT NULL,detail TEXT,config_hash TEXT NOT NULL,PRIMARY KEY(day,source));
    CREATE TABLE IF NOT EXISTS news(id TEXT PRIMARY KEY,source TEXT NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,
      published_at TEXT,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sentiment_seen(id TEXT PRIMARY KEY,day TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sentiment_daily(day TEXT NOT NULL,source TEXT NOT NULL,count INTEGER NOT NULL,
      score_sum REAL NOT NULL,PRIMARY KEY(day,source));
    CREATE TABLE IF NOT EXISTS occupations(code TEXT PRIMARY KEY,title TEXT NOT NULL,provenance TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(code TEXT NOT NULL REFERENCES occupations(code),task_id TEXT NOT NULL,
      description TEXT NOT NULL,weight REAL NOT NULL DEFAULT 1,PRIMARY KEY(code,task_id));
    CREATE TABLE IF NOT EXISTS exposure(code TEXT NOT NULL,task_id TEXT NOT NULL,automation REAL NOT NULL,
      augmentation REAL NOT NULL,usage_share REAL,provenance TEXT NOT NULL,PRIMARY KEY(code,task_id),
      FOREIGN KEY(code,task_id) REFERENCES tasks(code,task_id));
    CREATE TABLE IF NOT EXISTS published_exposure(soc TEXT PRIMARY KEY,score REAL NOT NULL,provenance TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_penetration(code TEXT NOT NULL,task_id TEXT NOT NULL,score REAL NOT NULL,
      provenance TEXT NOT NULL,PRIMARY KEY(code,task_id),FOREIGN KEY(code,task_id) REFERENCES tasks(code,task_id));
    CREATE INDEX IF NOT EXISTS observations_day ON observations(day,source);
    CREATE INDEX IF NOT EXISTS postings_hash ON postings(content_hash);
    CREATE INDEX IF NOT EXISTS postings_seen ON postings(last_seen);
    PRAGMA user_version=1;`);
  return db;
}

// Identity hashes do not include source, date, or description. Exact URL and
// company/title/location syndication matches share one posting across boards.
export function ingestPosting(db, source, item, date = day()) {
  const title = text(item.title).slice(0, 300), company = text(item.company).slice(0, 200);
  if (!title || !company) return false;
  const location = text(item.location).slice(0, 300), url = canonicalUrl(item.url);
  const description = text(item.description).slice(0, 16000);
  const tuple = hash([normalize(company), normalize(title), normalize(location)]);
  const keys = [`tuple:${tuple}`, ...(url ? [`url:${hash(url)}`] : []), ...(item.id ? [`native:${source}:${item.id}`] : [])];
  let id;
  for (const key of keys) {
    const match = db.prepare('SELECT posting_id FROM identities WHERE identity=?').get(key);
    if (match) { id = match.posting_id; break; }
  }
  id ??= tuple;
  // Stable first content wins on a syndicated duplicate.
  db.prepare(`INSERT INTO postings VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`)
    .run(id, title, company, location, url || null, description, hash([normalize(title), normalize(company), normalize(location), normalize(description)]), date, date, item.publishedAt || null);
  for (const key of keys) db.prepare('INSERT OR IGNORE INTO identities VALUES(?,?)').run(key, id);
  db.prepare('INSERT OR IGNORE INTO observations VALUES(?,?,?)').run(date, source, id);
  return true;
}

export function sourceRun(db, date, source, status, count, detail, config) {
  db.prepare('INSERT OR REPLACE INTO source_runs VALUES(?,?,?,?,?,?)')
    .run(date, source, status, count, detail || null, hash(config));
}

export function prune(db, retentionDays, now = new Date()) {
  const cutoff = ago(retentionDays, now);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['observations', 'source_runs', 'sentiment_daily', 'sentiment_seen']) db.prepare(`DELETE FROM ${table} WHERE day<?`).run(cutoff);
    db.prepare('DELETE FROM identities WHERE posting_id IN (SELECT id FROM postings WHERE last_seen<?)').run(cutoff);
    db.prepare('DELETE FROM postings WHERE last_seen<?').run(cutoff);
    db.prepare('DELETE FROM news WHERE last_seen<?').run(cutoff);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
