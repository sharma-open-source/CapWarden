import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runAsPackage,
  currentPackageFromContext,
} from '../../src/attribution/async-context';
import { attributeCurrentCall } from '../../src/attribution/stack';

const PROJECT_ROOT = path.resolve(__dirname, '../..');

/** Run a JS script in an isolated subprocess and return stdout. */
function runScript(code: string): string {
  const distPath = path.join(PROJECT_ROOT, 'dist').replace(/\\/g, '/');
  const tmp = path.join(os.tmpdir(), `capwarden-test-${Date.now()}.cjs`);
  // Replace relative dist paths with absolute ones
  const resolved = code
    .replace(/require\('\.\/dist\//g, `require('${distPath}/`)
    .replace(/require\("\.\/dist\//g, `require("${distPath}/`);
  fs.writeFileSync(tmp, resolved, 'utf-8');
  try {
    return execFileSync(process.execPath, [tmp], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        // Make node_modules resolvable from any cwd
        NODE_PATH: path.join(PROJECT_ROOT, 'node_modules'),
      },
    }).trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

describe('attribution/async-context — runAsPackage + currentPackageFromContext', () => {
  it('sets package name in context during synchronous execution', () => {
    let seen: string | null = null;
    runAsPackage('my-pkg', () => {
      seen = currentPackageFromContext();
    });
    expect(seen).toBe('my-pkg');
  });

  it('returns null when called outside runAsPackage', () => {
    expect(currentPackageFromContext()).toBeNull();
  });

  it('context is cleaned up after runAsPackage returns', () => {
    runAsPackage('my-pkg', () => {});
    expect(currentPackageFromContext()).toBeNull();
  });

  it('nested runAsPackage uses the innermost package name', () => {
    let inner: string | null = null;
    runAsPackage('outer-pkg', () => {
      runAsPackage('inner-pkg', () => {
        inner = currentPackageFromContext();
      });
    });
    expect(inner).toBe('inner-pkg');
  });

  it('propagates context into a Promise continuation', async () => {
    let seen: string | null = null;
    await runAsPackage('async-pkg', async () => {
      await Promise.resolve();
      seen = currentPackageFromContext();
    });
    expect(seen).toBe('async-pkg');
  });

  it('propagates context into a setTimeout callback', async () => {
    let seen: string | null = null;
    await new Promise<void>((resolve) => {
      runAsPackage('timer-pkg', () => {
        setTimeout(() => {
          seen = currentPackageFromContext();
          resolve();
        }, 0);
      });
    });
    expect(seen).toBe('timer-pkg');
  });
});

describe('attribution/stack — attributeCurrentCall with async context priority', () => {
  it('returns the async context package when set (GA priority)', () => {
    let result: string | null = null;
    runAsPackage('context-wins', () => {
      result = attributeCurrentCall();
    });
    expect(result).toBe('context-wins');
  });

  it('falls back to stack attribution when no context is set', () => {
    const result = attributeCurrentCall();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('attribution/async-context — installModuleLoadPatch (subprocess)', () => {
  /**
   * The Module._load patch intercepts ALL require() calls including Vitest's
   * own internals.  We validate the patch in isolated subprocesses.
   */
  it('installs and uninstalls without throwing', () => {
    const result = runScript(`
      'use strict';
      const { installModuleLoadPatch, uninstallModuleLoadPatch } = require('./dist/attribution/async-context.js');
      installModuleLoadPatch();
      installModuleLoadPatch(); // idempotent
      uninstallModuleLoadPatch();
      console.log('ok');
    `);
    expect(result).toBe('ok');
  });

  it('wrapped module functions still execute correctly after patch', () => {
    const result = runScript(`
      'use strict';
      const { installModuleLoadPatch } = require('./dist/attribution/async-context.js');
      installModuleLoadPatch();
      // commander exports a class (Command) — it must still be constructable after wrapping
      const { Command } = require('commander');
      const cmd = new Command();
      cmd.name('test-program');
      console.log(cmd.name());
    `);
    expect(result).toBe('test-program');
  });

  it('preserves static properties on a function export (e.g. express.Router)', () => {
    const result = runScript(`
      'use strict';
      const path = require('path');
      const os = require('os');
      const fs = require('fs');
      // Build a throwaway package whose module.exports is a function carrying statics.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-statics-'));
      const pkgDir = path.join(dir, 'node_modules', 'fake-express');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-express', version: '1.0.0', main: 'index.js' }));
      fs.writeFileSync(path.join(pkgDir, 'index.js'),
        'function createApp(){return \\'app\\';}\\n' +
        'createApp.Router = function Router(){return \\'router\\';};\\n' +
        'createApp.static = { json: true };\\n' +
        'module.exports = createApp;\\n');

      const { installModuleLoadPatch } = require('./dist/attribution/async-context.js');
      installModuleLoadPatch();
      const { createRequire } = require('module');
      const req = createRequire(path.join(dir, 'noop.js'));
      const e = req('fake-express');
      console.log(JSON.stringify({
        callable: typeof e === 'function' && e() === 'app',
        router: typeof e.Router === 'function' && e.Router() === 'router',
        staticObj: !!e.static && e.static.json === true,
      }));
    `);
    expect(JSON.parse(result)).toEqual({ callable: true, router: true, staticObj: true });
  });

  it('returns a stable identity across repeated requires of the same package', () => {
    const result = runScript(`
      'use strict';
      const path = require('path');
      const os = require('os');
      const fs = require('fs');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-identity-'));
      const pkgDir = path.join(dir, 'node_modules', 'fake-singleton');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-singleton', version: '1.0.0', main: 'index.js' }));
      fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = { state: {} };\\n');

      const { installModuleLoadPatch } = require('./dist/attribution/async-context.js');
      installModuleLoadPatch();
      const { createRequire } = require('module');
      const req = createRequire(path.join(dir, 'noop.js'));
      const a = req('fake-singleton');
      const b = req('fake-singleton');
      console.log(JSON.stringify({ sameExports: a === b, sameState: a.state === b.state }));
    `);
    expect(JSON.parse(result)).toEqual({ sameExports: true, sameState: true });
  });

  it('async context flows through Promise continuations after patch', () => {
    const result = runScript(`
      'use strict';
      const { installModuleLoadPatch, runAsPackage, currentPackageFromContext } = require('./dist/attribution/async-context.js');
      installModuleLoadPatch();
      let seen = null;
      async function main() {
        await runAsPackage('test-pkg', async () => {
          await Promise.resolve();
          seen = currentPackageFromContext();
        });
        console.log(seen);
      }
      main();
    `);
    expect(result).toBe('test-pkg');
  });
});
