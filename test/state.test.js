import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { restoreState, checkpointState } from '../scripts/state.js';
import { openDb } from '../src/db.js';
import { reserveBudget } from '../src/tagger.js';

test('state branch survives fresh runners with reservations intact and refuses corrupt archives', () => {
  const base = join(tmpdir(), 'opencode'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'unemployed-state-test-'));
  try {
    const remote = join(root, 'remote.git');
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
    const first = join(root, 'first');
    restoreState({ directory: first, remote });
    const db = openDb(join(first, 'jobs.sqlite'));
    reserveBudget(db, { monthlyUsd: 1 }, 12345);
    checkpointState(db, join(first, 'jobs.sqlite'), { directory: first }); db.close();
    const second = join(root, 'second');
    restoreState({ directory: second, remote });
    const restored = openDb(join(second, 'jobs.sqlite'));
    assert.equal(restored.prepare('SELECT SUM(reserved_micros) n FROM budget').get().n, 12345); restored.close();
    writeFileSync(join(second, 'jobs.sqlite.gz'), 'corrupt');
    execFileSync('git', ['add', 'jobs.sqlite.gz'], { cwd: second, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Test corrupt state'], { cwd: second, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'HEAD:refs/heads/pipeline-state'], { cwd: second, stdio: 'pipe' });
    assert.throws(() => restoreState({ directory: join(root, 'third'), remote }), /checksum mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
