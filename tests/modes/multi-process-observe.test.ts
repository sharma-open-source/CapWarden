/**
 * Regression test: multi-process observe must not lose events (the npm-clobber
 * bug).
 *
 * `capwarden observe -- npm test` preloads CapWarden into every nested Node
 * process. Each process used to write the report/policy independently on exit,
 * so the *parent* (npm) — which never sees the test runner's dependency events
 * — exited last and overwrote the complete policy its child had written. The
 * frozen policy then missed whole packages (vite, esbuild, …) and enforce
 * blocked them as "unknown to policy".
 *
 * Here the root app spawns a nested Node process, and only the *nested* process
 * touches the dependency. The final policy must still contain that dependency.
 */

import { spawnSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendRequireFlag } from '../../src/node-options.js';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DIST_REGISTER = path.join(PROJECT_ROOT, 'dist', 'register.js');

let fixtureDir: string;

beforeAll(() => {
  if (!fs.existsSync(DIST_REGISTER)) {
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'ignore' });
  }

  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capwarden-multiproc-'));

  const leakyDir = path.join(fixtureDir, 'node_modules', 'leaky');
  fs.mkdirSync(leakyDir, { recursive: true });
  fs.writeFileSync(
    path.join(leakyDir, 'package.json'),
    JSON.stringify({ name: 'leaky', version: '1.0.0', main: 'index.js' })
  );
  fs.writeFileSync(
    path.join(leakyDir, 'index.js'),
    `module.exports.run = function () { void process.env['MY_SECRET']; };`
  );

  // Only the nested child process touches the dependency; the parent (root
  // observed process) exits last with an empty dependency log.
  fs.writeFileSync(path.join(fixtureDir, 'child.js'), `require('leaky').run();`);
  fs.writeFileSync(
    path.join(fixtureDir, 'parent.js'),
    `const cp = require('child_process');
const r = cp.spawnSync(process.execPath, ['child.js'], { stdio: 'inherit', env: process.env });
process.exitCode = r.status ?? 1;
`
  );
  fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify({ name: 'fixture-app' }));
});

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe('observe across nested Node processes', () => {
  it("keeps the child's events when the parent flushes last", () => {
    const child = spawnSync(process.execPath, ['parent.js'], {
      cwd: fixtureDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CAPWARDEN: 'observe',
        CAPWARDEN_OUTPUT_DIR: fixtureDir,
        CAPWARDEN_RUN_ID: '', // blank out any id leaked from the test runner env
        NODE_OPTIONS: appendRequireFlag('', DIST_REGISTER),
      },
    });
    expect(child.status).toBe(0);

    const policy = JSON.parse(
      fs.readFileSync(path.join(fixtureDir, 'capwarden-policy.json'), 'utf-8')
    ) as { packages: Record<string, unknown> };

    expect(Object.keys(policy.packages)).toContain('leaky');
  });
});
