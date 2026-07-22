import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildInstallInventory, diffInventory } from '../../src/install-scripts/inventory';

let root: string;

function makePkg(nmDir: string, name: string, version: string, scripts?: Record<string, string>): void {
  const dir = path.join(nmDir, ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version, ...(scripts ? { scripts } : {}) })
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'capwarden-inv-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('buildInstallInventory', () => {
  it('returns empty when node_modules is absent', () => {
    const inv = buildInstallInventory(path.join(root, 'node_modules'));
    expect(inv.packages).toEqual([]);
  });

  it('finds top-level packages with lifecycle scripts and ignores those without', () => {
    const nm = path.join(root, 'node_modules');
    makePkg(nm, 'has-postinstall', '1.0.0', { postinstall: 'node x.js' });
    makePkg(nm, 'plain', '1.0.0', { test: 'vitest' }); // not a lifecycle script
    const inv = buildInstallInventory(nm);
    const names = inv.packages.map((p) => p.packageName);
    expect(names).toContain('has-postinstall');
    expect(names).not.toContain('plain');
  });

  it('handles scoped packages', () => {
    const nm = path.join(root, 'node_modules');
    makePkg(nm, '@scope/tool', '2.1.0', { preinstall: 'sh setup.sh' });
    const inv = buildInstallInventory(nm);
    expect(inv.packages.find((p) => p.packageName === '@scope/tool')?.version).toBe('2.1.0');
  });

  it('finds nested (transitive) installs (§10.3)', () => {
    const nm = path.join(root, 'node_modules');
    makePkg(nm, 'outer', '1.0.0');
    // outer/node_modules/deep declares a postinstall
    makePkg(path.join(nm, 'outer', 'node_modules'), 'deep', '3.0.0', { install: 'node build' });
    const inv = buildInstallInventory(nm);
    expect(inv.packages.map((p) => p.packageName)).toContain('deep');
  });

  it('dedupes identical name@version across the tree', () => {
    const nm = path.join(root, 'node_modules');
    makePkg(nm, 'dup', '1.0.0', { postinstall: 'x' });
    makePkg(path.join(nm, 'other', 'node_modules'), 'dup', '1.0.0', { postinstall: 'x' });
    makePkg(nm, 'other', '1.0.0');
    const inv = buildInstallInventory(nm);
    expect(inv.packages.filter((p) => p.packageName === 'dup')).toHaveLength(1);
  });
});

describe('diffInventory', () => {
  it('returns only newly-added packages', () => {
    const oldInv = { generatedAt: 't', packages: [{ packageName: 'a', version: '1', scripts: ['postinstall'] }] };
    const newInv = {
      generatedAt: 't',
      packages: [
        { packageName: 'a', version: '1', scripts: ['postinstall'] },
        { packageName: 'b', version: '2', scripts: ['install'] },
      ],
    };
    const added = diffInventory(oldInv, newInv);
    expect(added.map((p) => p.packageName)).toEqual(['b']);
  });
});
