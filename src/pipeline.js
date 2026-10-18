import { readFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ingestPosting, sourceRun, prune } from './db.js';
import { day, atomicWrite, assert } from './util.js';
import { Http } from './http.js';
import { jobSources, validatePosting } from './sources/jobs.js';
import { newsSources, ingestNews } from './sources/news.js';
import { sentimentSources, ingestSentiment } from './sources/sentiment.js';
import { tagNewPostings } from './tagger.js';
import { buildExport } from './metrics.js';
import { checkpointState } from '../scripts/state.js';
import { refreshReference } from './reference.js';

export function loadConfig(path = process.env.PIPELINE_CONFIG || 'config/pipeline.json') {
  const c = JSON.parse(readFileSync(path, 'utf8'));
  for (const key of ['batchSize', 'maxJobsPerRun', 'descriptionChars', 'outputTokensPerJob', 'maxAttemptsPerHash']) assert(Number.isInteger(c.llm[key]) && c.llm[key] > 0, `Invalid llm.${key}`);
  assert(c.llm.batchSize <= 20 && c.llm.maxJobsPerRun <= 2000, 'LLM run limits too large');
  assert(Number.isInteger(c.llm.requestTimeoutMs) && c.llm.requestTimeoutMs >= 1000 && c.llm.requestTimeoutMs <= 300000, 'Invalid LLM request timeout');
  assert(c.retentionDays >= 100 && c.retentionDays <= 730, 'retentionDays must preserve 90-day baseline');
  assert(c.llm.monthlyUsd >= 0 && c.llm.monthlyUsd <= 100, 'Monthly cap must be between $0 and $100');
  assert(c.llm.maxPromptUsdPerMillion >= 0 && c.llm.maxCompletionUsdPerMillion >= 0, 'Invalid token price ceilings');
  assert(c.metrics.minMatchedDays >= 1 && c.metrics.minMatchedDays <= 7, 'Invalid minimum matched days');
  if (process.env.PIPELINE_MAX_NEW_JOBS) {
    const limit = Number(process.env.PIPELINE_MAX_NEW_JOBS);
    assert(Number.isInteger(limit) && limit > 0 && limit <= c.llm.maxJobsPerRun, 'Manual tagging limit may only lower the configured run cap');
    c.llm.maxJobsPerRun = limit;
  }
  return c;
}

export async function collectGroup(db, http, config, kind, sources, ingest, date = day()) {
  let successes = 0;
  for (const source of sources) {
    const name = kind === 'jobs' ? `jobs:${source.name}` : source.name;
    if (!source.enabled) { sourceRun(db, date, name, 'disabled', 0, source.reason, source.config); continue; }
    const previous = db.prepare('SELECT status,config_hash FROM source_runs WHERE day=? AND source=?').get(date, name);
    // Successful sources are fetched once per UTC day, even on manual reruns.
    // Existing observations remain intact on later failures.
    if (previous?.status === 'ok') { successes++; continue; }
    try {
      const items = await source.collect();
      assert(Array.isArray(items), 'Adapter did not return an array');
      db.exec('BEGIN IMMEDIATE');
      let count = 0;
      try {
        for (const item of items) {
          if (kind === 'jobs' && !validatePosting(item)) continue;
          const accepted = ingest(db, source.name, item, date);
          if (accepted !== false) count++;
        }
        sourceRun(db, date, name, 'ok', count, kind === 'jobs' ? 'Bounded public API sample; not an exhaustive census' : null, source.config);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      console.log(`${name}: ${count} records`); successes++;
    } catch (error) {
      // Adapter errors omit URLs/tokens and response bodies from logs.
      const detail = error.message.slice(0, 250);
      sourceRun(db, date, name, 'error', 0, detail, source.config);
      console.warn(`${name}: ${detail}`);
    }
  }
  return successes;
}

export async function run({ config = loadConfig(), exportOnly = false, noLlm = false } = {}) {
  const db = openDb(config.database);
  const lockPath = `${config.database}.lock`;
  // Refuse simultaneous local writers as well as Actions concurrency.
  let lock;
  try { lock = openSync(lockPath, 'wx'); } catch { db.close(); throw new Error(`Pipeline lock exists: ${lockPath}. Check for an active run before removing a stale lock.`); }
  const http = new Http(config.http);
  const durable = process.env.PIPELINE_STATE_GIT === '1';
  const checkpoint = async () => { if (durable) checkpointState(db, config.database); };
  let succeeded = 0;
  try {
    if (!exportOnly) {
      try { console.log('Reference data:', await refreshReference(db, http, config.reference)); }
      catch (error) { console.warn(`Reference data: ${error.message}. Keeping previous reference snapshot.`); }
      succeeded = await collectGroup(db, http, config, 'jobs', jobSources(config.jobs, http), ingestPosting);
      await collectGroup(db, http, config, 'news', newsSources(config.news, http), ingestNews);
      await collectGroup(db, http, config, 'sentiment', sentimentSources(config.sentiment, http), ingestSentiment);
      if (!noLlm) {
        try {
          const result = await tagNewPostings(db, http, config.llm, { checkpoint, allowPaid: durable });
          console.log(`Tagging: ${result.state}, ${result.tagged} new postings`);
          db.prepare("INSERT OR REPLACE INTO meta VALUES('last_tagging',?)").run(JSON.stringify(result));
        } catch (error) { console.warn(`Tagging stopped: ${error.message}`); }
      }
      prune(db, config.retentionDays);
    }
    const output = buildExport(db, config);
    output.tagging = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='last_tagging'").get()?.value || 'null');
    await checkpoint();
    // An all-sources outage does not replace the last successful deployment.
    if (!exportOnly && succeeded === 0) throw new Error('No job source succeeded; preserved state but refused a new public export');
    atomicWrite(config.output, `${JSON.stringify(output)}\n`);
    console.log(`Exported ${output.jobs.length} occupations to ${config.output}`);
    return output;
  } finally { db.close(); closeSync(lock); unlinkSync(lockPath); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run({ exportOnly: process.argv.includes('--export-only'), noLlm: process.argv.includes('--no-llm') })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
