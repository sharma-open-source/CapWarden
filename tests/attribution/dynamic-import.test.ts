/**
 * NFR-2: a dependency reached via a dynamic `import()` is still attributed to
 * the package, not to first-party 'app'.
 *
 * The GA AsyncLocalStorage hook patches CJS `require()`, so ESM-only packages
 * reached via `import()` fall to the stack-walk path. This test pins that the
 * stack-walk correctly attributes an env read performed synchronously inside a
 * dynamically-imported package's exported function.
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

beforeAll(() => {
  if (!fs.existsSync(DIST_CLI)) execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'ignore' });
});

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capwarden-dyn-'));
  // An ESM-only dependency that reads process.env inside an exported function.
  const pkgDir = fx('node_modules', 'esm-leaky');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'esm-leaky', version: '1.0.0', type: 'module', main: 'index.mjs' })
  );
  fs.writeFileSync(
    path.join(pkgDir, 'index.mjs'),
    `export function readSecret() { return process.env['MY_SECRET']; }\n`
  );
  // App uses a dynamic import() to reach the ESM dependency.
  fs.writeFileSync(
    fx('app.mjs'),
    `const m = await import('esm-leaky'); m.readSecret();\n`
  );
});

afterEach(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

describe('dynamic import() attribution (NFR-2)', () => {
  it('attributes the env read to the dynamically-imported package', () => {
    const res = spawnSync(process.execPath, [DIST_CLI, 'observe', '--', process.execPath, 'app.mjs'], {
      cwd: fixtureDir,
      encoding: 'utf-8',
      env: { ...process.env, MY_SECRET: 'shh' },
    });
    expect(res.status).toBe(0);

    const report = JSON.parse(fs.readFileSync(fx('capwarden-report.json'), 'utf-8')) as {
      packages: Record<string, { env: string[] }>;
    };
    expect(report.packages['esm-leaky']?.env).toContain('MY_SECRET');
    // Must not be misattributed to first-party code.
    expect(report.packages['app']).toBeUndefined();
  });
});
