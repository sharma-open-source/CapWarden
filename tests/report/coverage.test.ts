/**
 * R5: instrumentation-coverage report of un-instrumentable packages.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCoverageReport } from '../../src/report/coverage';

let root: string;
let nm: string;

function makePkg(name: string, pkg: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = path.join(nm, ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pkg }));
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
  }
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'capwarden-cov-'));
  nm = path.join(root, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('buildCoverageReport', () => {
  it('flags packages with a binding.gyp as native addons', () => {
    makePkg('fast-native', { gypfile: true }, { 'binding.gyp': '{}' });
    const report = buildCoverageReport(nm);
    const e = report.partial.find((p) => p.packageName === 'fast-native');
    expect(e?.limitations).toContain('native-addon');
  });

  it('flags packages shipping a prebuilt .node binary', () => {
    makePkg('sharp', {}, { 'build/Release/sharp.node': '\0binary' });
    const report = buildCoverageReport(nm);
    expect(report.partial.find((p) => p.packageName === 'sharp')?.limitations).toContain('native-addon');
  });

  it('flags ESM-only packages', () => {
    makePkg('pure-esm', { type: 'module', main: 'index.js' });
    const report = buildCoverageReport(nm);
    expect(report.partial.find((p) => p.packageName === 'pure-esm')?.limitations).toContain('esm-only');
  });

  it('does not flag dual packages that expose a require condition', () => {
    makePkg('dual', { type: 'module', exports: { '.': { require: './i.cjs', import: './i.js' } } });
    const report = buildCoverageReport(nm);
    expect(report.partial.find((p) => p.packageName === 'dual')).toBeUndefined();
  });

  it('does not flag a plain CJS package', () => {
    makePkg('plain', { main: 'index.js' });
    const report = buildCoverageReport(nm);
    expect(report.partial.find((p) => p.packageName === 'plain')).toBeUndefined();
  });

  it('scopes and nesting: finds a nested native addon under a scope', () => {
    makePkg('@scope/wrapper', {});
    fs.mkdirSync(path.join(nm, '@scope', 'wrapper', 'node_modules'), { recursive: true });
    const deepNm = path.join(nm, '@scope', 'wrapper', 'node_modules');
    const dir = path.join(deepNm, 'deep-native');
    fs.mkdirSync(path.join(dir, 'prebuilds'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'deep-native', version: '2.0.0' }));
    fs.writeFileSync(path.join(dir, 'prebuilds', 'x.node'), '\0');
    const report = buildCoverageReport(nm);
    expect(report.partial.find((p) => p.packageName === 'deep-native')?.limitations).toContain('native-addon');
  });
});
