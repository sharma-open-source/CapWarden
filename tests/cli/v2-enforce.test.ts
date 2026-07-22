/**
 * FR-10 end-to-end: v2 strict enforcement and v1→v2 migration through the CLI.
 */

import { spawnSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DIST_CLI = path.join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

// Connects to example.com:443 over TLS; the host is the strict sub-detail.
const LEAKY_INDEX = `
const tls = require('tls');
module.exports.run = function (host) {
  try {
    const s = tls.connect({ host, port: 443, timeout: 50 });
    s.on('error', () => {}); s.on('secureConnect', () => s.destroy());
  } catch (e) {}
};
`;
const APP_JS = `require('leaky').run(process.env.TARGET_HOST);`;

let fixtureDir: string;
const fx = (...p: string[]) => path.join(fixtureDir, ...p);

function runCli(args: string[], env: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: fixtureDir,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

beforeAll(() => {
  if (!fs.existsSync(DIST_CLI)) execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'ignore' });
});

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capwarden-v2-'));
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

function writeV2Policy(policy: unknown): void {
  fs.writeFileSync(fx('capwarden-policy.json'), JSON.stringify(policy));
}

describe('observe --schema v2 --strict', () => {
  it('generates a v2 policy keyed by name@version with pinned host tokens', () => {
    const res = runCli(['observe', '--schema', 'v2', '--strict', '--', process.execPath, 'app.js'], {
      TARGET_HOST: 'a.example.com',
    });
    expect(res.status).toBe(0);
    const policy = JSON.parse(fs.readFileSync(fx('capwarden-policy.json'), 'utf-8'));
    expect(policy.version).toBe(2);
    expect(policy.packages['leaky@1.0.0']).toBeDefined();
    expect(policy.packages['leaky@1.0.0'].strict).toBe(true);
    expect(policy.packages['leaky@1.0.0'].grants.net).toContain('a.example.com:443');
  });
});

describe('enforce with a strict v2 policy', () => {
  it('allows the pinned host and blocks a different host', () => {
    writeV2Policy({
      version: 2,
      generatedAt: 't',
      defaults: { strict: true, onViolation: 'block' },
      packages: { 'leaky@1.0.0': { grants: { net: ['a.example.com:443'] }, strict: true } },
    });

    const allowed = runCli(['enforce', '--', process.execPath, 'app.js'], { TARGET_HOST: 'a.example.com' });
    expect(allowed.status).toBe(0);

    const blocked = runCli(['enforce', '--', process.execPath, 'app.js'], { TARGET_HOST: 'b.example.com' });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('CAPWARDEN BLOCKED');
    expect(blocked.stderr).toContain('b.example.com:443');
  });

  it('lax v2 grant allows any host for the granted kind', () => {
    writeV2Policy({
      version: 2,
      generatedAt: 't',
      defaults: { strict: false, onViolation: 'block' },
      packages: { 'leaky@1.0.0': { grants: { net: ['*'] }, strict: false } },
    });
    const res = runCli(['enforce', '--', process.execPath, 'app.js'], { TARGET_HOST: 'anywhere.example.com' });
    expect(res.status).toBe(0);
  });
});

describe('capwarden migrate', () => {
  it('rewrites a committed v1 policy as a behavior-preserving v2', () => {
    fs.writeFileSync(
      fx('capwarden-policy.json'),
      JSON.stringify({ version: 1, packages: { leaky: ['net'] } })
    );
    const res = runCli(['migrate']);
    expect(res.status).toBe(0);
    const migrated = JSON.parse(fs.readFileSync(fx('capwarden-policy.json'), 'utf-8'));
    expect(migrated.version).toBe(2);
    expect(migrated.packages['leaky'].grants.net).toEqual(['*']);
    // Behavior-preserving: any host still allowed.
    const enforce = runCli(['enforce', '--', process.execPath, 'app.js'], { TARGET_HOST: 'x.example.com' });
    expect(enforce.status).toBe(0);
  });
});
