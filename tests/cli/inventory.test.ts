/**
 * CLI tests for `capwarden inventory` (GAP §1.5, FR-15).
 *
 * The regression under test: `inventory --diff` used to write the freshly-built
 * inventory unconditionally, so every diff after the first was clean by
 * construction — silently defeating the install-script review gate. The write
 * is now gated behind an explicit `--write`.
 *
 * These run the built CLI as a subprocess against a temp fixture project whose
 * node_modules contains one package declaring a postinstall lifecycle script.
 */

import { spawnSync, execSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DIST_CLI = path.join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

const EMPTY_INVENTORY = JSON.stringify({
  generatedAt: '2020-01-01T00:00:00.000Z',
  packages: [],
});

let fixtureDir: string;

function inventoryFile(): string {
  return path.join(fixtureDir, 'capwarden-inventory.json');
}

function runInventory(...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [DIST_CLI, 'inventory', ...args], {
    cwd: fixtureDir,
    encoding: 'utf-8',
  });
}

beforeAll(() => {
  if (!fs.existsSync(DIST_CLI)) {
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'ignore' });
  }
});

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capwarden-cli-'));
  const pkgDir = path.join(fixtureDir, 'node_modules', 'evil-pkg');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({
      name: 'evil-pkg',
      version: '1.0.0',
      scripts: { postinstall: 'node steal.js' },
    })
  );
});

afterEach(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe('capwarden inventory --diff (GAP §1.5)', () => {
  it('flags a new install script and exits non-zero', () => {
    fs.writeFileSync(inventoryFile(), EMPTY_INVENTORY);
    const res = runInventory('--diff');
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain('evil-pkg');
  });

  it('does NOT overwrite the committed baseline (the §1.5 bug)', () => {
    fs.writeFileSync(inventoryFile(), EMPTY_INVENTORY);
    runInventory('--diff');
    // Baseline must be byte-for-byte unchanged after a diff.
    expect(fs.readFileSync(inventoryFile(), 'utf-8')).toBe(EMPTY_INVENTORY);
  });

  it('keeps flagging the addition on repeated diffs (never goes clean)', () => {
    fs.writeFileSync(inventoryFile(), EMPTY_INVENTORY);
    const first = runInventory('--diff');
    const second = runInventory('--diff');
    expect(first.status).toBe(1);
    expect(second.status).toBe(1); // under the old bug this was 0
  });

  it('reports an actionable error (not a clean pass) when no baseline exists', () => {
    const res = runInventory('--diff');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--write');
    expect(fs.existsSync(inventoryFile())).toBe(false);
  });
});

describe('capwarden inventory (listing / --write)', () => {
  it('plain listing prints JSON and writes nothing', () => {
    const res = runInventory();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('evil-pkg');
    expect(fs.existsSync(inventoryFile())).toBe(false);
  });

  it('--write seeds the committed baseline; a following --diff is clean', () => {
    const write = runInventory('--write');
    expect(write.status).toBe(0);
    expect(fs.existsSync(inventoryFile())).toBe(true);

    const diff = runInventory('--diff');
    expect(diff.status).toBe(0);
    expect(diff.stdout + diff.stderr).toContain('No new install scripts');
  });
});
