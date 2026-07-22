/**
 * FR-8 / FR-14: install-event synthesis and lifecycle-script governance.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  installEventsFromInventory,
  checkInstallScripts,
  runInstallScripts,
} from '../../src/install-scripts/runner';
import type { InstallInventory } from '../../src/install-scripts/inventory';
import type { PolicyV1 } from '../../src/policy/schema-v1';
import type { PolicyV2 } from '../../src/policy/schema-v2';

const inventory: InstallInventory = {
  generatedAt: 't',
  packages: [
    { packageName: 'sketchy', version: '1.0.0', scripts: ['postinstall'] },
    { packageName: 'buildtool', version: '2.0.0', scripts: ['install', 'postinstall'] },
  ],
};

describe('installEventsFromInventory (FR-8)', () => {
  it('emits one install event per (package, script)', () => {
    const events = installEventsFromInventory(inventory);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      packageName: 'sketchy',
      detail: { kind: 'install', script: 'postinstall', packageName: 'sketchy' },
    });
  });
});

describe('checkInstallScripts', () => {
  it('v1: grants scripts only for packages with the `install` kind', () => {
    const policy: PolicyV1 = { version: 1, packages: { buildtool: ['install'] } };
    const results = checkInstallScripts(inventory, policy);
    expect(results.find((r) => r.packageName === 'sketchy')?.granted).toBe(false);
    expect(results.filter((r) => r.packageName === 'buildtool').every((r) => r.granted)).toBe(true);
  });

  it('v2: grants only the pinned script token under strict', () => {
    const policy: PolicyV2 = {
      version: 2,
      generatedAt: 't',
      defaults: { strict: true, onViolation: 'block' },
      packages: { buildtool: { grants: { install: ['install'] }, strict: true } },
    };
    const results = checkInstallScripts(inventory, policy);
    const bt = results.filter((r) => r.packageName === 'buildtool');
    expect(bt.find((r) => r.script === 'install')?.granted).toBe(true);
    expect(bt.find((r) => r.script === 'postinstall')?.granted).toBe(false);
  });
});

describe('runInstallScripts', () => {
  it('blocks every script and never executes when no policy is given', () => {
    const spawn = vi.fn();
    const res = runInstallScripts({ inventory, cwd: '/x', spawn: spawn as never });
    expect(res.blocked).toHaveLength(3);
    expect(res.exitCode).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('executes only granted scripts under preload when execute=true', () => {
    const policy: PolicyV1 = { version: 1, packages: { buildtool: ['install'] } };
    const spawn = vi.fn().mockReturnValue({ status: 0 });
    const res = runInstallScripts({
      inventory,
      policy,
      cwd: '/proj',
      execute: true,
      registerPath: '/proj/dist/register.js',
      spawn: spawn as never,
    });
    // sketchy is blocked (exitCode 1) and never run; buildtool's two scripts run.
    expect(res.exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    const [, args, opts] = spawn.mock.calls[0];
    expect(args).toContain('install');
    expect(opts.env.CAPWARDEN).toBe('observe');
    expect(opts.env.NODE_OPTIONS).toContain('register.js');
  });

  it('propagates a non-zero child exit', () => {
    const policy: PolicyV1 = { version: 1, packages: { sketchy: ['install'], buildtool: ['install'] } };
    const spawn = vi.fn().mockReturnValue({ status: 7 });
    const res = runInstallScripts({ inventory, policy, cwd: '/p', execute: true, spawn: spawn as never });
    expect(res.blocked).toHaveLength(0);
    expect(res.exitCode).toBe(1);
  });
});
