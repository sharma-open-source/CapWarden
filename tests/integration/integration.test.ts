/**
 * End-to-end integration tests for CapWarden.
 *
 * Each test spins up a real subprocess with a minimal fixture:
 *   node_modules/test-pkg/index.js  — reads process.env['CAPWARDEN_TEST_KEY']
 *   app.js                          — require('test-pkg')
 *
 * This exercises the full pipeline:
 *   --require dist/register.js  →  interceptors  →  attribution  →  policy / report
 */

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DIST_REGISTER = path.join(PROJECT_ROOT, 'dist', 'register.js');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const NODE_PATH = path.join(PROJECT_ROOT, 'node_modules');

// fixture contents
const TEST_PKG_INDEX = `
  process.env['CAPWARDEN_TEST_KEY'];  // reads env at module load — should be attributed to test-pkg
  module.exports = {};
`;
const APP_JS = `require('test-pkg');`;

let fixtureDir: string;

function fixturePath(...parts: string[]): string {
  return path.join(fixtureDir, ...parts);
}

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capwarden-integ-'));

  // fake npm package
  const pkgDir = fixturePath('node_modules', 'test-pkg');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'test-pkg', version: '1.0.0' }),
  );
  fs.writeFileSync(path.join(pkgDir, 'index.js'), TEST_PKG_INDEX);

  // entry-point script
  fs.writeFileSync(fixturePath('app.js'), APP_JS);
});

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

/** Run app.js with --require capwarden/register in the fixture dir. */
function runApp(extraEnv: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['--require', DIST_REGISTER, 'app.js'], {
    cwd: fixtureDir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      NODE_PATH,
      CAPWARDEN: '',          // default off unless overridden
      ...extraEnv,
    },
  });
}

/**
 * Run an inline JS script in the fixture dir with absolute dist/ paths injected.
 * Use this for tests that need fine-grained control (e.g. update mode).
 */
function runScript(content: string, extraEnv: Record<string, string> = {}): SpawnSyncReturns<string> {
  const resolved = content.replace(
    /require\('\.\/dist\//g,
    `require('${DIST_DIR.replace(/\\/g, '/')}/`,
  );
  const tmpFile = fixturePath(`_inline_${Date.now()}.cjs`);
  fs.writeFileSync(tmpFile, resolved);
  const result = spawnSync(process.execPath, [tmpFile], {
    cwd: fixtureDir,
    encoding: 'utf-8',
    env: { ...process.env, NODE_PATH, CAPWARDEN: '', ...extraEnv },
  });
  fs.rmSync(tmpFile, { force: true });
  return result;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function writePolicy(packages: Record<string, string[]>): void {
  fs.writeFileSync(fixturePath('capwarden-policy.json'), JSON.stringify({ version: 1, packages }));
}

function readJsonFile(name: string): unknown {
  return JSON.parse(fs.readFileSync(fixturePath(name), 'utf-8'));
}

function cleanArtifacts(...names: string[]): void {
  for (const name of names) {
    const p = fixturePath(name);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

// ─── observe ─────────────────────────────────────────────────────────────────

describe('observe mode', () => {
  beforeEach(() => cleanArtifacts('capwarden-report.json', 'capwarden-policy.json'));

  it('exits zero', () => {
    const result = runApp({ CAPWARDEN: 'observe' });
    expect(result.status).toBe(0);
  });

  it('creates capwarden-report.json and capwarden-policy.json', () => {
    runApp({ CAPWARDEN: 'observe' });
    expect(fs.existsSync(fixturePath('capwarden-report.json'))).toBe(true);
    expect(fs.existsSync(fixturePath('capwarden-policy.json'))).toBe(true);
  });

  it('report attributes env access to test-pkg', () => {
    runApp({ CAPWARDEN: 'observe' });
    const report = readJsonFile('capwarden-report.json') as {
      packages: Record<string, { env: string[] }>;
    };
    expect(report.packages).toHaveProperty('test-pkg');
    expect(report.packages['test-pkg'].env).toContain('CAPWARDEN_TEST_KEY');
  });

  it('generated policy grants env to test-pkg', () => {
    runApp({ CAPWARDEN: 'observe' });
    const policy = readJsonFile('capwarden-policy.json') as {
      packages: Record<string, string[]>;
    };
    expect(policy.packages['test-pkg']).toContain('env');
  });

  it('report is deterministic across runs (NFR-3)', () => {
    runApp({ CAPWARDEN: 'observe' });
    const first = fs.readFileSync(fixturePath('capwarden-policy.json'), 'utf-8');
    cleanArtifacts('capwarden-report.json', 'capwarden-policy.json');
    runApp({ CAPWARDEN: 'observe' });
    const second = fs.readFileSync(fixturePath('capwarden-policy.json'), 'utf-8');
    expect(first).toBe(second);
  });

  it('never logs env values, only key names (NFR-5)', () => {
    const result = runApp({
      CAPWARDEN: 'observe',
      CAPWARDEN_TEST_KEY: 'ultra-secret-value-xyz',
    });
    expect(result.stdout).not.toContain('ultra-secret-value-xyz');
    expect(result.stderr).not.toContain('ultra-secret-value-xyz');
    const reportContent = fs.readFileSync(fixturePath('capwarden-report.json'), 'utf-8');
    expect(reportContent).not.toContain('ultra-secret-value-xyz');
  });

  it('does nothing and exits zero when CAPWARDEN is unset (off mode)', () => {
    const result = runApp({ CAPWARDEN: '' });
    expect(result.status).toBe(0);
    expect(fs.existsSync(fixturePath('capwarden-report.json'))).toBe(false);
  });
});

// ─── enforce ─────────────────────────────────────────────────────────────────

describe('enforce mode', () => {
  beforeEach(() => cleanArtifacts('capwarden.config.json'));

  it('exits zero when policy grants the accessed capability', () => {
    writePolicy({ 'test-pkg': ['env'] });
    const result = runApp({ CAPWARDEN: 'enforce' });
    expect(result.status).toBe(0);
  });

  it('exits non-zero when policy denies the capability', () => {
    writePolicy({ 'test-pkg': [] });
    const result = runApp({ CAPWARDEN: 'enforce' });
    expect(result.status).toBe(1);
  });

  it('violation message names the blocked package', () => {
    writePolicy({ 'test-pkg': [] });
    const result = runApp({ CAPWARDEN: 'enforce' });
    expect(result.stderr).toContain('CAPWARDEN BLOCKED');
    expect(result.stderr).toContain('test-pkg');
  });

  it('violation message includes the capability detail (env key)', () => {
    writePolicy({ 'test-pkg': [] });
    const result = runApp({ CAPWARDEN: 'enforce' });
    expect(result.stderr).toContain('env:CAPWARDEN_TEST_KEY');
  });

  it('blocks a completely unknown package (zero-capability default)', () => {
    writePolicy({});   // test-pkg absent → zero capabilities
    const result = runApp({ CAPWARDEN: 'enforce' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CAPWARDEN BLOCKED');
  });

  it('fail-open: onViolation log exits zero but still prints violation (NFR-4)', () => {
    writePolicy({ 'test-pkg': [] });
    fs.writeFileSync(
      fixturePath('capwarden.config.json'),
      JSON.stringify({ onViolation: 'log' }),
    );
    const result = runApp({ CAPWARDEN: 'enforce' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('CAPWARDEN BLOCKED');
  });

  it('exits non-zero when policy file is missing', () => {
    cleanArtifacts('capwarden-policy.json');
    const result = runApp({ CAPWARDEN: 'enforce' });
    expect(result.status).not.toBe(0);
  });
});

// ─── update ──────────────────────────────────────────────────────────────────

describe('update mode', () => {
  it('prints "no capability changes" when policy is already up to date', () => {
    // policy already grants env for test-pkg
    writePolicy({ 'test-pkg': ['env'] });

    const result = runScript(`
      const { startUpdateMode } = require('./dist/modes/update.js');
      startUpdateMode({ policyPath: 'capwarden-policy.json' });
      require('test-pkg');
    `);

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/no capability changes/i);
  });

  it('detects a newly required capability vs committed policy', () => {
    // committed policy grants nothing
    writePolicy({ 'test-pkg': [] });

    const result = runScript(`
      const { startUpdateMode } = require('./dist/modes/update.js');
      startUpdateMode({ policyPath: 'capwarden-policy.json' });
      require('test-pkg');
    `);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('env');  // diff shows + env
  });

  it('detects a new package appearing vs committed policy', () => {
    // committed policy has no entry for test-pkg at all
    writePolicy({});

    const result = runScript(`
      const { startUpdateMode } = require('./dist/modes/update.js');
      startUpdateMode({ policyPath: 'capwarden-policy.json' });
      require('test-pkg');
    `);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('test-pkg');
    expect(result.stderr).toMatch(/new package/i);
  });

  it('exits non-zero with --failOnAdditions when new capabilities detected', () => {
    writePolicy({ 'test-pkg': [] });

    const result = runScript(`
      const { startUpdateMode } = require('./dist/modes/update.js');
      startUpdateMode({ policyPath: 'capwarden-policy.json', failOnAdditions: true });
      require('test-pkg');
    `);

    expect(result.status).toBe(1);
  });

  it('exits zero with --failOnAdditions when no additions (policy already correct)', () => {
    writePolicy({ 'test-pkg': ['env'] });

    const result = runScript(`
      const { startUpdateMode } = require('./dist/modes/update.js');
      startUpdateMode({ policyPath: 'capwarden-policy.json', failOnAdditions: true });
      require('test-pkg');
    `);

    expect(result.status).toBe(0);
  });
});

// ─── ESM support (NFR-2) ─────────────────────────────────────────────────────

const DIST_REGISTER_MJS = path.join(PROJECT_ROOT, 'dist', 'register.mjs');
const DIST_HOOKS_MJS = path.join(PROJECT_ROOT, 'dist', 'hooks.mjs');

/** Run an ESM app.mjs with --import capwarden/register. */
function runEsmApp(
  appFile: string,
  extraEnv: Record<string, string> = {},
): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    ['--import', DIST_REGISTER_MJS, appFile],
    {
      cwd: fixtureDir,
      encoding: 'utf-8',
      env: { ...process.env, NODE_PATH, CAPWARDEN: '', ...extraEnv },
    },
  );
}

describe('ESM mode — --import capwarden/register (NFR-2)', () => {
  const ESM_PKG_DIR_NAME = path.join('node_modules', 'test-esm-pkg');
  const ESM_APP = 'app-esm.mjs';

  beforeAll(() => {
    // ESM package that reads an env var at module load time
    const esmPkgDir = fixturePath(ESM_PKG_DIR_NAME);
    fs.mkdirSync(esmPkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(esmPkgDir, 'package.json'),
      JSON.stringify({ name: 'test-esm-pkg', version: '1.0.0', type: 'module', exports: './index.mjs' }),
    );
    fs.writeFileSync(
      path.join(esmPkgDir, 'index.mjs'),
      `process.env['CAPWARDEN_ESM_KEY'];\nexport default {};\n`,
    );
    // ESM entry-point app
    fs.writeFileSync(fixturePath(ESM_APP), `import 'test-esm-pkg';\n`);
  });

  beforeEach(() => cleanArtifacts('capwarden-report.json', 'capwarden-policy.json', 'capwarden.config.json'));

  it('exits zero in observe mode', () => {
    const result = runEsmApp(ESM_APP, { CAPWARDEN: 'observe' });
    expect(result.status).toBe(0);
  });

  it('creates report and policy files', () => {
    runEsmApp(ESM_APP, { CAPWARDEN: 'observe' });
    expect(fs.existsSync(fixturePath('capwarden-report.json'))).toBe(true);
    expect(fs.existsSync(fixturePath('capwarden-policy.json'))).toBe(true);
  });

  it('report attributes env access to test-esm-pkg', () => {
    runEsmApp(ESM_APP, { CAPWARDEN: 'observe' });
    const report = readJsonFile('capwarden-report.json') as {
      packages: Record<string, { env: string[] }>;
    };
    expect(report.packages).toHaveProperty('test-esm-pkg');
    expect(report.packages['test-esm-pkg'].env).toContain('CAPWARDEN_ESM_KEY');
  });

  it('generated policy grants env to test-esm-pkg', () => {
    runEsmApp(ESM_APP, { CAPWARDEN: 'observe' });
    const policy = readJsonFile('capwarden-policy.json') as {
      packages: Record<string, string[]>;
    };
    expect(policy.packages['test-esm-pkg']).toContain('env');
  });

  it('enforce: exits zero when policy grants env', () => {
    writePolicy({ 'test-esm-pkg': ['env'] });
    const result = runEsmApp(ESM_APP, { CAPWARDEN: 'enforce' });
    expect(result.status).toBe(0);
  });

  it('enforce: exits non-zero when policy denies env', () => {
    // Deny by granting only net (no env)
    writePolicy({ 'test-esm-pkg': ['net'] });
    const result = runEsmApp(ESM_APP, { CAPWARDEN: 'enforce' });
    expect(result.status).toBe(1);
  });

  it('enforce: violation message names the ESM package', () => {
    writePolicy({ 'test-esm-pkg': ['net'] });
    const result = runEsmApp(ESM_APP, { CAPWARDEN: 'enforce' });
    expect(result.stderr).toContain('CAPWARDEN BLOCKED');
    expect(result.stderr).toContain('test-esm-pkg');
  });

  it('never logs env values in ESM mode (NFR-5)', () => {
    const result = runEsmApp(ESM_APP, {
      CAPWARDEN: 'observe',
      CAPWARDEN_ESM_KEY: 'ultra-secret-esm-value',
    });
    expect(result.stdout).not.toContain('ultra-secret-esm-value');
    expect(result.stderr).not.toContain('ultra-secret-esm-value');
    const reportContent = fs.readFileSync(fixturePath('capwarden-report.json'), 'utf-8');
    expect(reportContent).not.toContain('ultra-secret-esm-value');
  });
});

describe('ESM mode — --loader capwarden/hooks (NFR-2, legacy)', () => {
  const ESM_APP = 'app-esm.mjs'; // reuse fixture created above

  beforeEach(() => cleanArtifacts('capwarden-report.json', 'capwarden-policy.json'));

  it('exits zero when --require + --loader flags are combined', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--require', DIST_REGISTER,
        '--experimental-loader', DIST_HOOKS_MJS,
        ESM_APP,
      ],
      {
        cwd: fixtureDir,
        encoding: 'utf-8',
        env: { ...process.env, NODE_PATH, CAPWARDEN: 'observe' },
      },
    );
    // Node prints an ExperimentalWarning for --loader; strip it for assert
    const stderr = result.stderr.replace(/ExperimentalWarning[^\n]*/g, '').trim();
    expect(result.status).toBe(0);
    expect(stderr).toContain('Observe complete');
  });
});

