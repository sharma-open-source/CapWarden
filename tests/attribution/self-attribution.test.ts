/**
 * Regression test: when CapWarden is installed as a real dependency, its own
 * frames live under `node_modules/capwarden/…`. The stack walker used to pick
 * that up as the nearest node_modules frame and blame 'capwarden' for every
 * access it intercepted — so observe froze a bogus `capwarden: [env, fs]`
 * grant and enforce then blocked legitimate spawns (e.g. vitest → esbuild)
 * as "capwarden tried proc:…".
 *
 * This runs the compiled register from inside a fixture node_modules/capwarden
 * and asserts accesses are attributed to the real accessor, never to capwarden.
 */

import { spawnSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendRequireFlag } from '../../src/node-options.js';

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(PROJECT_ROOT, 'dist');

let fixtureDir: string;

beforeAll(() => {
  if (!fs.existsSync(path.join(DIST, 'register.js'))) {
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'ignore' });
  }

  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capwarden-self-'));

  // Install CapWarden's compiled dist as node_modules/capwarden in the fixture.
  const cwDir = path.join(fixtureDir, 'node_modules', 'capwarden');
  fs.mkdirSync(cwDir, { recursive: true });
  fs.cpSync(DIST, path.join(cwDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(cwDir, 'package.json'),
    JSON.stringify({ name: 'capwarden', version: '0.0.0-test' })
  );

  // A dependency that spawns a process and reads env.
  const leakyDir = path.join(fixtureDir, 'node_modules', 'leaky');
  fs.mkdirSync(leakyDir, { recursive: true });
  fs.writeFileSync(
    path.join(leakyDir, 'package.json'),
    JSON.stringify({ name: 'leaky', version: '1.0.0', main: 'index.js' })
  );
  fs.writeFileSync(
    path.join(leakyDir, 'index.js'),
    `const cp = require('child_process');
module.exports.run = function () {
  void process.env['MY_SECRET'];
  cp.execSync('${process.execPath.replace(/\\/g, '\\\\')} -e "0"');
};
`
  );

  fs.writeFileSync(path.join(fixtureDir, 'app.js'), `require('leaky').run();`);
  fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify({ name: 'fixture-app' }));
});

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

describe('attribution with capwarden installed under node_modules', () => {
  it('never attributes intercepted accesses to capwarden itself', () => {
    const register = path.join(fixtureDir, 'node_modules', 'capwarden', 'dist', 'register.js');
    const child = spawnSync(process.execPath, ['app.js'], {
      cwd: fixtureDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CAPWARDEN: 'observe',
        CAPWARDEN_OUTPUT_DIR: fixtureDir,
        NODE_OPTIONS: appendRequireFlag('', register),
      },
    });
    expect(child.status).toBe(0);

    const policyPath = path.join(fixtureDir, 'capwarden-policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf-8')) as {
      packages: Record<string, unknown>;
    };

    expect(Object.keys(policy.packages)).not.toContain('capwarden');
    expect(Object.keys(policy.packages)).toContain('leaky');
  });
});
