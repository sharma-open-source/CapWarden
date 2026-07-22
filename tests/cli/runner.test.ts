/**
 * CLI runner tests (FR-2, FR-6) — the subprocess lifecycle from §7.
 *
 *   capwarden observe  -- <cmd>   regenerate a baseline by running <cmd>
 *   capwarden enforce  -- <cmd>   run <cmd> under the committed policy
 *   capwarden update --write -- <cmd>   re-observe, diff, rewrite the policy
 *
 * Also covers the SIGTERM flush guarantee (GAP §3): an interrupted observe run
 * still writes its report.
 */

import { spawnSync, spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DIST_CLI = path.join(PROJECT_ROOT, 'dist', 'cli', 'index.js');
const DIST_REGISTER = path.join(PROJECT_ROOT, 'dist', 'register.js');

const LEAKY_INDEX = `
const cp = require('child_process');
module.exports.run = function () {
  void process.env['MY_SECRET'];            // env access → attributed to leaky
  if (process.env['LEAKY_PROC'] === '1') {  // optional proc access
    try { cp.execSync('true'); } catch (e) { /* blocked under enforce */ }
  }
};
`;
const APP_JS = `require('leaky').run();`;

let fixtureDir: string;

function fx(...p: string[]): string {
  return path.join(fixtureDir, ...p);
}

function runCli(
  args: string[],
  env: Record<string, string> = {}
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: fixtureDir,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

beforeAll(() => {
  if (!fs.existsSync(DIST_CLI) || !fs.existsSync(DIST_REGISTER)) {
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'ignore' });
  }
});

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capwarden-run-'));
  const pkgDir = fx('node_modules', 'leaky');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'leaky', version: '1.0.0', main: 'index.js' })
  );
  fs.writeFileSync(path.join(pkgDir, 'index.js'), LEAKY_INDEX);
  fs.writeFileSync(fx('app.js'), APP_JS);
});

afterEach(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe('capwarden observe -- <cmd> (FR-2)', () => {
  it('runs the command and generates a policy from what it observed', () => {
    const res = runCli(['observe', '--', process.execPath, 'app.js'], { MY_SECRET: 'x' });
    expect(res.status).toBe(0);
    expect(fs.existsSync(fx('capwarden-policy.json'))).toBe(true);
    const policy = JSON.parse(fs.readFileSync(fx('capwarden-policy.json'), 'utf-8'));
    expect(policy.packages.leaky).toContain('env');
  });
});

describe('capwarden enforce -- <cmd> (FR-2, FR-17)', () => {
  function seedPolicy(pkgs: Record<string, string[]>): void {
    fs.writeFileSync(
      fx('capwarden-policy.json'),
      JSON.stringify({ version: 1, packages: pkgs }, null, 2)
    );
  }

  it('exits 0 when the run stays within the committed policy', () => {
    seedPolicy({ leaky: ['env'] });
    const res = runCli(['enforce', '--', process.execPath, 'app.js'], { MY_SECRET: 'x' });
    expect(res.status).toBe(0);
  });

  it('exits non-zero and reports a block on a policy violation', () => {
    seedPolicy({ leaky: ['env'] }); // proc not granted
    const res = runCli(['enforce', '--', process.execPath, 'app.js'], {
      MY_SECRET: 'x',
      LEAKY_PROC: '1',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('CAPWARDEN BLOCKED');
    expect(res.stderr).toContain('leaky');
  });

  it('--fail-open logs the violation but exits 0', () => {
    seedPolicy({ leaky: ['env'] });
    const res = runCli(['enforce', '--fail-open', '--', process.execPath, 'app.js'], {
      MY_SECRET: 'x',
      LEAKY_PROC: '1',
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('CAPWARDEN BLOCKED'); // still surfaced
  });
});

describe('capwarden update --write -- <cmd> (FR-6)', () => {
  it('rewrites the policy with newly observed capabilities', () => {
    // Seed a baseline granting only env.
    fs.writeFileSync(
      fx('capwarden-policy.json'),
      JSON.stringify({ version: 1, packages: { leaky: ['env'] } }, null, 2)
    );
    const res = runCli(['update', '--write', '--', process.execPath, 'app.js'], {
      MY_SECRET: 'x',
      LEAKY_PROC: '1',
    });
    expect(res.status).toBe(0);
    const policy = JSON.parse(fs.readFileSync(fx('capwarden-policy.json'), 'utf-8'));
    expect(policy.packages.leaky).toEqual(expect.arrayContaining(['env', 'proc']));
  });

  it('without --write, leaves the committed policy untouched', () => {
    const committed = JSON.stringify({ version: 1, packages: { leaky: ['env'] } }, null, 2);
    fs.writeFileSync(fx('capwarden-policy.json'), committed);
    const res = runCli(['update', '--', process.execPath, 'app.js'], {
      MY_SECRET: 'x',
      LEAKY_PROC: '1',
    });
    expect(res.status).toBe(0);
    expect(fs.readFileSync(fx('capwarden-policy.json'), 'utf-8')).toBe(committed);
  });
});

describe('observe flushes on SIGTERM (GAP §3)', () => {
  it('writes a report when the run is interrupted', async () => {
    // A long-lived app: record its env access, drop a ready marker, then idle.
    fs.writeFileSync(
      fx('app.js'),
      `require('leaky').run();
       require('fs').writeFileSync('ready', '1');
       setInterval(() => {}, 1000);`
    );

    const child = spawn(process.execPath, ['--require', DIST_REGISTER, 'app.js'], {
      cwd: fixtureDir,
      env: { ...process.env, CAPWARDEN: 'observe', MY_SECRET: 'x' },
      stdio: 'ignore',
    });
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));

    // Wait for the app to be ready, then interrupt it.
    for (let i = 0; i < 100 && !fs.existsSync(fx('ready')); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(fs.existsSync(fx('ready'))).toBe(true);
    child.kill('SIGTERM');
    await exited;

    expect(fs.existsSync(fx('capwarden-report.json'))).toBe(true);
    const report = JSON.parse(fs.readFileSync(fx('capwarden-report.json'), 'utf-8'));
    expect(report.packages.leaky).toBeDefined();
  });
});
