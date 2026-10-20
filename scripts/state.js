import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicWrite, hash, assert } from '../src/util.js';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function stateKey(key, directory) {
  key ||= existsSync(join(directory, 'encryption.key')) ? readFileSync(join(directory, 'encryption.key'), 'utf8').trim() : null;
  assert(key && /^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, 'base64').length === 32, 'STATE_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return Buffer.from(key, 'base64');
}

export function sealSnapshot(bytes, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('unemployed.world-state-v2'));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
}

export function unsealSnapshot(bytes, key) {
  assert(bytes.length > 28, 'Encrypted state is truncated');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from('unemployed.world-state-v2'));
  decipher.setAuthTag(bytes.subarray(12, 28));
  try { return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]); }
  catch { throw new Error('State decryption failed: wrong encryption key or tampered archive'); }
}

export function restoreState({ directory = '.state', remote = process.env.PIPELINE_REMOTE, branch = 'pipeline-state', encryptionKey = process.env.STATE_ENCRYPTION_KEY } = {}) {
  assert(remote, 'PIPELINE_REMOTE is required to restore persistent state');
  assert(!existsSync(join(directory, '.git')), 'State directory is already initialized');
  const key = stateKey(encryptionKey, directory);
  mkdirSync(directory, { recursive: true });
  git(directory, ['init', '-b', branch]);
  git(directory, ['remote', 'add', 'origin', remote]);
  git(directory, ['config', 'user.name', 'unemployed-world-pipeline']);
  git(directory, ['config', 'user.email', 'pipeline@unemployed.world']);
  // A network/auth failure throws. Only a successful empty ls-remote means
  // first run, so a missing/corrupt state cannot silently reset history.
  const ref = git(directory, ['ls-remote', '--heads', 'origin', branch]);
  if (ref) {
    git(directory, ['fetch', '--depth=1', 'origin', branch]);
    git(directory, ['checkout', '-b', 'restored-state', 'FETCH_HEAD']);
    const archive = join(directory, 'jobs.sqlite.enc');
    assert(existsSync(archive) && existsSync(join(directory, 'manifest.json')), 'State branch is incomplete; refusing fresh database');
    const bytes = readFileSync(archive), manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    assert(manifest.version === 2 && manifest.encryption === 'aes-256-gcm' && manifest.sha256 === hash(bytes), 'Persistent state checksum mismatch or unencrypted legacy archive');
    atomicWrite(join(directory, 'jobs.sqlite'), gunzipSync(unsealSnapshot(bytes, key), { maxOutputLength: 512 * 1024 * 1024 }));
    console.log('Restored persistent SQLite state');
  } else {
    atomicWrite(join(directory, 'first-run'), 'New state branch; no requests have been billed.\n');
    console.log('First run: initializing persistent state');
  }
  atomicWrite(join(directory, '.gitignore'), 'jobs.sqlite\njobs.sqlite-*\njobs.sqlite.gz\nencryption.key\n*.tmp\nfirst-run\n');
}

export function checkpointState(db, databasePath, { directory = '.state', branch = 'pipeline-state', encryptionKey = process.env.STATE_ENCRYPTION_KEY } = {}) {
  assert(existsSync(join(directory, '.git')), 'Paid calls require an initialized persistent state Git repository');
  // DELETE journal mode + synchronous FULL means the committed file is a
  // complete snapshot. There is only one writer (Actions concurrency group).
  const bytes = sealSnapshot(gzipSync(readFileSync(databasePath), { level: 6 }), stateKey(encryptionKey, directory));
  atomicWrite(join(directory, 'jobs.sqlite.enc'), bytes);
  atomicWrite(join(directory, 'manifest.json'), JSON.stringify({ version: 2, encryption: 'aes-256-gcm', sha256: hash(bytes), updatedAt: new Date().toISOString() }));
  git(directory, ['add', '.gitignore', 'jobs.sqlite.enc', 'manifest.json']);
  const changes = git(directory, ['status', '--porcelain']);
  if (changes) git(directory, ['commit', '-m', 'Persist pipeline database']);
  // Never force-push; a concurrent/manual writer causes a safe failure.
  git(directory, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { restoreState(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
