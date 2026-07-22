/**
 * Lifecycle-script governance (FR-8, FR-14).
 *
 * Install scripts (`preinstall`/`install`/`postinstall`/`prepare`) run with full
 * process privilege at `npm install` time — the highest-value supply-chain
 * attack surface. CapWarden treats "package X ran lifecycle script Y" as a
 * first-class `install` capability:
 *
 *   1. `installEventsFromInventory` synthesizes one `install` AccessEvent per
 *      (package, script) discovered in node_modules (FR-8).
 *   2. `checkInstallScripts` decides, against the committed policy, which of
 *      those a package is permitted to run (v1: the `install` kind; v2: the
 *      exact script token).
 *   3. `runInstallScripts` is the CI gate: it blocks ungranted scripts and can
 *      optionally execute the allowed ones under CapWarden preload so their
 *      runtime capabilities are governed too (FR-14).
 */

import { spawnSync } from 'child_process';
import * as path from 'path';
import type { AccessEvent } from '../types.js';
import type { PolicyV1 } from '../policy/schema-v1.js';
import { isGranted } from '../policy/schema-v1.js';
import { isGrantedV2, type PolicyV2 } from '../policy/schema-v2.js';
import type { InstallInventory } from './inventory.js';
import { appendRequireFlag } from '../node-options.js';

/** FR-8: one `install` capability event per package lifecycle script. */
export function installEventsFromInventory(inventory: InstallInventory): AccessEvent[] {
  const events: AccessEvent[] = [];
  for (const entry of inventory.packages) {
    for (const script of entry.scripts) {
      events.push({
        packageName: entry.packageName,
        detail: { kind: 'install', script, packageName: entry.packageName },
        timestamp: 0,
      });
    }
  }
  return events;
}

export interface InstallCheckResult {
  packageName: string;
  script: string;
  granted: boolean;
}

/** Decide, per (package, script), whether the policy grants running it. */
export function checkInstallScripts(
  inventory: InstallInventory,
  policy: PolicyV1 | PolicyV2
): InstallCheckResult[] {
  return installEventsFromInventory(inventory).map((event) => {
    const script = event.detail.kind === 'install' ? event.detail.script : '';
    const granted =
      policy.version === 2
        ? isGrantedV2(policy, event.packageName, 'install', script)
        : isGranted(policy, event.packageName, 'install');
    return { packageName: event.packageName, script, granted };
  });
}

export interface RunInstallScriptsOptions {
  /** node_modules-rooted inventory of lifecycle scripts. */
  inventory: InstallInventory;
  /** Committed policy; when omitted, every script is treated as ungranted. */
  policy?: PolicyV1 | PolicyV2;
  /** Project root (used to resolve each package's directory for `--run`). */
  cwd: string;
  /** Actually execute the granted scripts under CapWarden preload (FR-14). */
  execute?: boolean;
  /** CapWarden mode to run executed scripts under. Defaults to 'observe'. */
  mode?: 'observe' | 'enforce';
  /** Absolute path to register.js for the preload. Required when execute=true. */
  registerPath?: string;
  /** Injected spawn for testing. Defaults to child_process.spawnSync. */
  spawn?: typeof spawnSync;
}

export interface RunInstallScriptsResult {
  results: InstallCheckResult[];
  /** Packages+scripts blocked because the policy did not grant `install`. */
  blocked: InstallCheckResult[];
  /** Non-zero when any script was blocked or an executed script failed. */
  exitCode: number;
}

/**
 * Govern lifecycle scripts against the policy. Blocked scripts are never run.
 * When `execute` is set, granted scripts run sequentially under CapWarden
 * preload; a non-zero child exit propagates to the returned exitCode.
 */
export function runInstallScripts(options: RunInstallScriptsOptions): RunInstallScriptsResult {
  const { inventory, policy, cwd, execute = false, mode = 'observe' } = options;
  const spawn = options.spawn ?? spawnSync;

  const results = policy
    ? checkInstallScripts(inventory, policy)
    : installEventsFromInventory(inventory).map((e) => ({
        packageName: e.packageName,
        script: e.detail.kind === 'install' ? e.detail.script : '',
        granted: false,
      }));

  const blocked = results.filter((r) => !r.granted);
  let exitCode = blocked.length > 0 ? 1 : 0;

  if (execute) {
    const register = options.registerPath;
    const priorNodeOptions = process.env['NODE_OPTIONS'] ?? '';
    const nodeOptions = register
      ? appendRequireFlag(priorNodeOptions, register)
      : priorNodeOptions;

    const byPackage = new Map<string, string[]>();
    for (const r of results) {
      if (!r.granted) continue;
      const list = byPackage.get(r.packageName) ?? [];
      list.push(r.script);
      byPackage.set(r.packageName, list);
    }

    for (const [pkg, scripts] of byPackage) {
      const pkgDir = path.join(cwd, 'node_modules', ...pkg.split('/'));
      for (const script of scripts) {
        const child = spawn('npm', ['run', script, '--if-present'], {
          cwd: pkgDir,
          stdio: 'inherit',
          env: { ...process.env, CAPWARDEN: mode, NODE_OPTIONS: nodeOptions },
        });
        const status = child.status ?? (child.error ? 1 : 0);
        if (status !== 0) exitCode = 1;
      }
    }
  }

  return { results, blocked, exitCode };
}
