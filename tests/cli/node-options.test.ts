/**
 * Regression tests for NODE_OPTIONS construction.
 *
 * A project path containing a space (e.g. `~/Project/untitled folder`) used to
 * produce `NODE_OPTIONS=--require /path/with space/register.js`, which Node
 * splits at the space and then crashes with MODULE_NOT_FOUND on
 * `/path/with` before the user's command even starts.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendRequireFlag } from '../../src/node-options.js';

describe('appendRequireFlag', () => {
  it('double-quotes the register path', () => {
    expect(appendRequireFlag('', '/a/b/register.js')).toBe('--require "/a/b/register.js"');
  });

  it('preserves pre-existing NODE_OPTIONS', () => {
    expect(appendRequireFlag('--max-old-space-size=512', '/a/register.js')).toBe(
      '--max-old-space-size=512 --require "/a/register.js"'
    );
  });

  it('escapes literal double quotes in the path', () => {
    expect(appendRequireFlag('', '/a/we"ird/register.js')).toBe(
      '--require "/a/we\\"ird/register.js"'
    );
  });
});

describe('preload path with a space (real Node parsing)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capwarden nodeopts-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('Node preloads a register file whose path contains a space', () => {
    const register = path.join(dir, 'register.js');
    fs.writeFileSync(register, `process.stdout.write('preloaded;');`);

    const child = spawnSync(process.execPath, ['-e', `process.stdout.write('ran')`], {
      encoding: 'utf-8',
      env: { ...process.env, NODE_OPTIONS: appendRequireFlag('', register) },
    });

    expect(child.stderr).toBe('');
    expect(child.stdout).toBe('preloaded;ran');
    expect(child.status).toBe(0);
  });
});
