/**
 * CLI tests for config overrides (FR-19, FR-20), `--version`, and the
 * human-readable `report` command (FR-16).
 */

import { spawnSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DIST_CLI = path.join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

const LEAKY_INDEX = `
const cp = require('child_process');
module.exports.run = function () {
  void process.env['MY_SECRET'];
  try { cp.execSync('true'); } catch (e) {}
};
`;
const APP_JS = `require('leaky').run();`;

let fixtureDir: string;
const fx = (...p: string[]) => path.join(fixtureDir, ...p);

function runCli(args: string[], env: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: fixtureDir,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

function writeConfig(cfg: unknown): void {
  fs.writeFileSync(fx('capwarden.config.json'), JSON.stringify(cfg));
}
function writePolicy(pkgs: Record<string, string[]>): void {
  fs.writeFileSync(fx('capwarden-policy.json'), JSON.stringify({ version: 1, packages: pkgs }));
}

beforeAll(() => {
  if (!fs.existsSync(DIST_CLI)) execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'ignore' });
});

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capwarden-ovr-'));
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

describe('enforce config overrides', () => {
  it('ignored: an ignored package is never blocked (FR-19)', () => {
    writePolicy({ leaky: [] }); // grants nothing
    writeConfig({ ignored: ['leaky'] });
    const res = runCli(['enforce', '--', process.execPath, 'app.js'], { MY_SECRET: 'x' });
    expect(res.status).toBe(0);
  });

  it('denied: a pre-denied kind blocks even when the policy grants it (FR-20)', () => {
    writePolicy({ leaky: ['env', 'proc'] }); // policy WOULD allow proc
    writeConfig({ denied: { leaky: ['proc'] } });
    const res = runCli(['enforce', '--', process.execPath, 'app.js'], { MY_SECRET: 'x' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('explicitly denied');
  });

  it('denied "*": applies to every package', () => {
    writePolicy({ leaky: ['env', 'proc'] });
    writeConfig({ denied: { '*': ['proc'] } });
    const res = runCli(['enforce', '--', process.execPath, 'app.js'], { MY_SECRET: 'x' });
    expect(res.status).toBe(1);
  });
});

describe('capwarden --version', () => {
  it('reports the package.json version (no drift)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
    const res = runCli(['--version']);
    expect(res.stdout.trim()).toBe(pkg.version);
  });
});

describe('capwarden report (FR-16)', () => {
  it('prints a human-readable report of observed capabilities', () => {
    // Generate a report first.
    runCli(['observe', '--', process.execPath, 'app.js'], { MY_SECRET: 'x' });
    const res = runCli(['report']);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('leaky');
    expect(res.stderr).toContain('Observe Report');
  });
});
