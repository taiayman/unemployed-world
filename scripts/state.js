import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { atomicWrite, hash, assert } from '../src/util.js';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function restoreState({ directory = '.state', remote = process.env.PIPELINE_REMOTE, branch = 'pipeline-state' } = {}) {
  assert(remote, 'PIPELINE_REMOTE is required to restore persistent state');
  assert(!existsSync(join(directory, '.git')), 'State directory is already initialized');
  mkdirSync(directory, { recursive: true });
  git(directory, ['init', '-b', branch]);
  git(directory, ['remote', 'add', 'origin', remote]);
  git(directory, ['config', 'user.name', 'unemployed-world-pipeline']);
  git(directory, ['config', 'user.email', 'pipeline@unemployed.world']);
  // A network/auth failure throws. Only a successful empty ls-remote means
  // first run, so a missing/corrupt state cannot silently reset the budget.
  const ref = git(directory, ['ls-remote', '--heads', 'origin', branch]);
  if (ref) {
    git(directory, ['fetch', '--depth=1', 'origin', branch]);
    git(directory, ['checkout', '-b', 'restored-state', 'FETCH_HEAD']);
    const archive = join(directory, 'jobs.sqlite.gz');
    assert(existsSync(archive) && existsSync(join(directory, 'manifest.json')), 'State branch is incomplete; refusing fresh database');
    const bytes = readFileSync(archive), manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    assert(manifest.version === 1 && manifest.sha256 === hash(bytes), 'Persistent state checksum mismatch');
    atomicWrite(join(directory, 'jobs.sqlite'), gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }));
    console.log('Restored persistent SQLite state');
  } else {
    atomicWrite(join(directory, 'first-run'), 'New state branch; no requests have been billed.\n');
    console.log('First run: initializing persistent state');
  }
  atomicWrite(join(directory, '.gitignore'), 'jobs.sqlite\njobs.sqlite-*\n*.tmp\nfirst-run\n');
}

export function checkpointState(db, databasePath, { directory = '.state', branch = 'pipeline-state' } = {}) {
  assert(existsSync(join(directory, '.git')), 'Paid calls require an initialized persistent state Git repository');
  // DELETE journal mode + synchronous FULL means the committed file is a
  // complete snapshot. There is only one writer (Actions concurrency group).
  const bytes = gzipSync(readFileSync(databasePath), { level: 6 });
  atomicWrite(join(directory, 'jobs.sqlite.gz'), bytes);
  atomicWrite(join(directory, 'manifest.json'), JSON.stringify({ version: 1, sha256: hash(bytes), updatedAt: new Date().toISOString() }));
  git(directory, ['add', '.gitignore', 'jobs.sqlite.gz', 'manifest.json']);
  const changes = git(directory, ['status', '--porcelain']);
  if (changes) git(directory, ['commit', '-m', 'Persist pipeline database and budget reservations']);
  // Never force-push; a concurrent/manual writer causes a safe failure.
  git(directory, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { restoreState(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
