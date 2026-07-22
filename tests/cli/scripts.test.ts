/**
 * FR-14 end-to-end: `capwarden scripts --enforce` gates lifecycle scripts.
 */

import { spawnSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DIST_CLI = path.join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

let fixtureDir: string;
const fx = (...p: string[]) => path.join(fixtureDir, ...p);

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: fixtureDir,
    encoding: 'utf-8',
    env: { ...process.env },
  });
}

function makePkg(name: string, scripts: Record<string, string>): void {
  const dir = fx('node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', scripts })
  );
}

beforeAll(() => {
  if (!fs.existsSync(DIST_CLI)) execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'ignore' });
});

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capwarden-scr-'));
});

afterEach(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe('capwarden scripts', () => {
  it('lists discovered lifecycle scripts (no --enforce)', () => {
    makePkg('sketchy', { postinstall: 'node evil.js' });
    const res = runCli(['scripts']);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('sketchy');
    expect(res.stderr).toContain('postinstall');
  });

  it('--enforce blocks a package with no `install` grant', () => {
    makePkg('sketchy', { postinstall: 'node evil.js' });
    fs.writeFileSync(fx('capwarden-policy.json'), JSON.stringify({ version: 1, packages: {} }));
    const res = runCli(['scripts', '--enforce']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('BLOCKED install scripts');
    expect(res.stderr).toContain('sketchy');
  });

  it('--enforce passes when the policy grants `install`', () => {
    makePkg('buildtool', { install: 'node build.js' });
    fs.writeFileSync(
      fx('capwarden-policy.json'),
      JSON.stringify({ version: 1, packages: { buildtool: ['install'] } })
    );
    const res = runCli(['scripts', '--enforce']);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('permitted');
  });
});
