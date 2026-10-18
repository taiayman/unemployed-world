import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert } from '../src/util.js';

const repository = process.env.GITHUB_REPOSITORY;
assert(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository || ''), 'GITHUB_REPOSITORY is required');
const base = join(tmpdir(), 'opencode');
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(join(base, 'unemployed-export-'));
const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  // Clone the latest main, not the workflow's potentially old checkout. Only
  // the public aggregate export is committed; never copy database snapshots.
  git(['clone', '--depth=1', '--single-branch', '--branch', 'main', `https://github.com/${repository}.git`, '.']);
  git(['config', 'user.name', 'unemployed-world-pipeline']);
  git(['config', 'user.email', 'pipeline@unemployed.world']);
  copyFileSync('site/jobs.json', join(directory, 'site', 'jobs.json'));
  git(['add', '--force', 'site/jobs.json']);
  if (git(['status', '--porcelain', '--', 'site/jobs.json'])) {
    git(['commit', '-m', 'Publish daily jobs export']);
    git(['push', 'origin', 'HEAD:refs/heads/main']);
    console.log('Published aggregate jobs.json; Cloudflare Git integration will deploy it');
  } else console.log('Public export unchanged');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
