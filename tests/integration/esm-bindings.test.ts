/**
 * ESM named-binding interception tests.
 *
 * Named imports of builtins (`import { readFile } from 'node:fs/promises'`)
 * are SNAPSHOTS taken when Node first evaluates the builtin's ESM facade —
 * first evaluation wins, process-wide. These tests pin down the three cases
 * that matter for CapWarden:
 *
 *   1. Preload runs first (supported deployment) → named imports ARE
 *      intercepted, observe attributes and enforce blocks.
 *   2. A hostile/earlier preload evaluates the facade before CapWarden →
 *      named imports silently bypass; the register.mjs self-check must warn.
 *   3. Late (programmatic) activation after bindings exist → bypass. This is
 *      a regression guard: if activation ever becomes lazy, this documents
 *      what breaks.
 */

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DIST_REGISTER_MJS = path.join(PROJECT_ROOT, 'dist', 'register.mjs');
const DIST_DIR = PROJECT_ROOT.replace(/\\/g, '/') + '/dist';
const NODE_PATH = path.join(PROJECT_ROOT, 'node_modules');

let fixtureDir: string;

function fixturePath(...parts: string[]): string {
  return path.join(fixtureDir, ...parts);
}

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capwarden-esmbind-'));

  // ESM package that reads a file via a NAMED import from node:fs/promises.
  const pkgDir = fixturePath('node_modules', 'test-esm-fs-pkg');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'test-esm-fs-pkg', version: '1.0.0', type: 'module', exports: './index.mjs' }),
  );
  fs.writeFileSync(
    path.join(pkgDir, 'index.mjs'),
    `import { readFile } from 'node:fs/promises';\n` +
    `export function readMarker() { return readFile('marker.txt', 'utf-8'); }\n`,
  );

  fs.writeFileSync(fixturePath('marker.txt'), 'marker-content\n');

  // App: trigger the package's named-binding fs read at startup.
  fs.writeFileSync(
    fixturePath('app.mjs'),
    `import { readMarker } from 'test-esm-fs-pkg';\nawait readMarker();\n`,
  );

  // Hostile preload: evaluates the node:fs/promises facade before CapWarden.
  fs.writeFileSync(fixturePath('early-preload.mjs'), `import 'node:fs/promises';\n`);

  // Late-activation app: named binding is created first, observe mode starts
  // afterwards, then the package reads through the stale binding.
  fs.writeFileSync(
    fixturePath('app-late.mjs'),
    `import { readMarker } from 'test-esm-fs-pkg';\n` +
    `import { createRequire } from 'node:module';\n` +
    `const require = createRequire(import.meta.url);\n` +
    `const { startObserveMode } = require('${DIST_DIR}/modes/observe.js');\n` +
    `startObserveMode({});\n` +
    `await readMarker();\n`,
  );
});

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of ['capwarden-report.json', 'capwarden-policy.json', 'capwarden.config.json']) {
    const p = fixturePath(name);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
});

function writePolicy(packages: Record<string, string[]>): void {
  fs.writeFileSync(fixturePath('capwarden-policy.json'), JSON.stringify({ version: 1, packages }));
}

function run(nodeArgs: string[], env: Record<string, string>): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, nodeArgs, {
    cwd: fixtureDir,
    encoding: 'utf-8',
    env: { ...process.env, NODE_PATH, CAPWARDEN: '', ...env },
  });
}

describe('named ESM imports — preload first (supported deployment)', () => {
  it('observe attributes the named-import fs read to the package', () => {
    const result = run(['--import', DIST_REGISTER_MJS, 'app.mjs'], { CAPWARDEN: 'observe' });
    expect(result.status).toBe(0);
    const report = JSON.parse(fs.readFileSync(fixturePath('capwarden-report.json'), 'utf-8')) as {
      packages: Record<string, { fs?: string[] }>;
    };
    expect(report.packages).toHaveProperty('test-esm-fs-pkg');
    expect(report.packages['test-esm-fs-pkg'].fs?.length).toBeGreaterThan(0);
  });

  it('enforce blocks the named-import fs read when policy denies fs', () => {
    writePolicy({ 'test-esm-fs-pkg': ['env'] }); // no fs grant
    const result = run(['--import', DIST_REGISTER_MJS, 'app.mjs'], { CAPWARDEN: 'enforce' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('test-esm-fs-pkg');
  });

  it('does not print the binding self-check warning', () => {
    const result = run(['--import', DIST_REGISTER_MJS, 'app.mjs'], { CAPWARDEN: 'observe' });
    expect(result.stderr).not.toContain('BYPASS CapWarden');
  });
});

describe('named ESM imports — earlier preload evaluated the facade first', () => {
  it('the named-import fs read bypasses enforce (documented limitation)', () => {
    writePolicy({ 'test-esm-fs-pkg': ['env'] }); // no fs grant
    const result = run(
      ['--import', fixturePath('early-preload.mjs'), '--import', DIST_REGISTER_MJS, 'app.mjs'],
      { CAPWARDEN: 'enforce' },
    );
    // The stale snapshot points at the unpatched original: no violation fires.
    // If this ever starts exiting 1, Node made the bindings live — the
    // self-check and this suite should be revisited.
    expect(result.status).toBe(0);
  });

  it('the register self-check warns that bindings were created too early', () => {
    const result = run(
      ['--import', fixturePath('early-preload.mjs'), '--import', DIST_REGISTER_MJS, 'app.mjs'],
      { CAPWARDEN: 'observe' },
    );
    expect(result.stderr).toContain('[CapWarden] WARNING');
    expect(result.stderr).toContain('BYPASS CapWarden');
  });

  it('stays silent when CAPWARDEN is off (nothing patched, nothing to miss)', () => {
    const result = run(
      ['--import', fixturePath('early-preload.mjs'), '--import', DIST_REGISTER_MJS, 'app.mjs'],
      { CAPWARDEN: '' },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('BYPASS CapWarden');
  });
});

describe('named ESM imports — late programmatic activation', () => {
  it('reads through pre-existing named bindings are not observed', () => {
    const result = run(['app-late.mjs'], { CAPWARDEN: '' });
    expect(result.status).toBe(0);
    const report = JSON.parse(fs.readFileSync(fixturePath('capwarden-report.json'), 'utf-8')) as {
      packages: Record<string, { fs?: string[] }>;
    };
    // The binding was snapshotted before startObserveMode() patched fs, so the
    // read is invisible. Documents why activation must happen via preload.
    expect(report.packages['test-esm-fs-pkg']?.fs ?? []).toHaveLength(0);
  });
});
