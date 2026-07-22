/**
 * Open Q3: monorepo/workspace discovery + first-party folding.
 */

import { spawnSync, execSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  discoverWorkspacePackages,
  setFirstPartyPackages,
  isFirstPartyPackage,
  _resetFirstPartyPackages,
} from '../../src/attribution/workspaces';

let root: string;

function write(rel: string, content: string): void {
  const fp = path.join(root, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
}
function makeWsPkg(rel: string, name: string): void {
  write(path.join(rel, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'capwarden-ws-'));
  _resetFirstPartyPackages();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  _resetFirstPartyPackages();
});

describe('discoverWorkspacePackages', () => {
  it('returns [] for a non-workspace project', () => {
    write('package.json', JSON.stringify({ name: 'solo', version: '1.0.0' }));
    expect(discoverWorkspacePackages(root)).toEqual([]);
  });

  it('expands npm/yarn `workspaces` globs to package names', () => {
    write('package.json', JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }));
    makeWsPkg('packages/ui', '@acme/ui');
    makeWsPkg('packages/core', '@acme/core');
    const names = discoverWorkspacePackages(root).sort();
    expect(names).toEqual(['@acme/core', '@acme/ui']);
  });

  it('supports the object form { packages: [...] }', () => {
    write('package.json', JSON.stringify({ name: 'mono', workspaces: { packages: ['libs/a'] } }));
    makeWsPkg('libs/a', 'lib-a');
    expect(discoverWorkspacePackages(root)).toEqual(['lib-a']);
  });

  it('parses pnpm-workspace.yaml packages globs', () => {
    write('package.json', JSON.stringify({ name: 'mono' }));
    write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n  - 'tooling'\n");
    makeWsPkg('packages/x', '@m/x');
    makeWsPkg('tooling', 'tooling-pkg');
    expect(discoverWorkspacePackages(root).sort()).toEqual(['@m/x', 'tooling-pkg']);
  });
});

describe('first-party folding', () => {
  it('marks registered workspace names as first-party', () => {
    expect(isFirstPartyPackage('@acme/ui')).toBe(false);
    setFirstPartyPackages(['@acme/ui', '@acme/core']);
    expect(isFirstPartyPackage('@acme/ui')).toBe(true);
    expect(isFirstPartyPackage('lodash')).toBe(false);
  });
});

describe('end-to-end (Open Q3)', () => {
  const PROJECT_ROOT = path.resolve(__dirname, '../..');
  const DIST_CLI = path.join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

  beforeAll(() => {
    if (!fs.existsSync(DIST_CLI)) execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'ignore' });
  });

  it('does not attribute a workspace sibling as a third-party dependency', () => {
    // Root workspace manifest + the source package under packages/*.
    write('package.json', JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }));
    makeWsPkg('packages/ui', '@acme/ui');
    // The same package as installed (symlink-equivalent) into node_modules.
    write(
      'node_modules/@acme/ui/package.json',
      JSON.stringify({ name: '@acme/ui', version: '1.0.0', main: 'index.js' })
    );
    write('node_modules/@acme/ui/index.js', `module.exports.go = () => void process.env['SECRET'];`);
    // A real third-party dep that also reads env, for contrast.
    write(
      'node_modules/vendor/package.json',
      JSON.stringify({ name: 'vendor', version: '1.0.0', main: 'index.js' })
    );
    write('node_modules/vendor/index.js', `module.exports.go = () => void process.env['SECRET'];`);
    write('app.js', `require('@acme/ui').go(); require('vendor').go();`);

    const res = spawnSync(process.execPath, [DIST_CLI, 'observe', '--', process.execPath, 'app.js'], {
      cwd: root,
      encoding: 'utf-8',
      env: { ...process.env, SECRET: 'x' },
    });
    expect(res.status).toBe(0);

    const report = JSON.parse(fs.readFileSync(path.join(root, 'capwarden-report.json'), 'utf-8')) as {
      packages: Record<string, unknown>;
    };
    // The workspace sibling is folded into 'app'; the real dependency is not.
    expect(report.packages['@acme/ui']).toBeUndefined();
    expect(report.packages['vendor']).toBeDefined();
  });
});
