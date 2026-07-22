/**
 * CapWarden configuration file loader.
 *
 * Reads capwarden.config.json or .capwardenrc from the project root.
 * All fields are optional; defaults are safe for adopt-then-tighten.
 *
 * FR-19, FR-20, NFR-4.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CapabilityKind } from './types.js';

export interface CapWardenConfig {
  /**
   * Packages for which strict sub-detail enforcement is enabled.
   * In MVP this is a flag; v2 schema handles sub-detail pinning.
   */
  strictPackages?: string[];

  /** Capability kinds that are globally denied, regardless of policy grants. */
  denied?: Partial<Record<string, CapabilityKind[]>>;

  /**
   * Packages to ignore entirely (always allowed, not tracked).
   * Use sparingly — hides accesses from reports.
   */
  ignored?: string[];

  /**
   * What to do on a *policy violation* (a package using an ungranted
   * capability).
   * 'block' (default): block + non-zero exit (CI gate).
   * 'log': warn only.
   *
   * Distinct from `onInternalError` below — this is about dependency behavior,
   * not CapWarden bugs.
   */
  onViolation?: 'block' | 'log';

  /**
   * What to do on a *CapWarden internal error* (a bug in attribution or policy
   * evaluation) — NFR-4.
   * 'fail-open' (default): log once, let the host operation proceed, so a guard
   * bug never takes down the app.
   * 'fail-closed': rethrow (opt-in hard-fail).
   */
  onInternalError?: 'fail-open' | 'fail-closed';

  /** Path to the committed policy file. Defaults to 'capwarden-policy.json'. */
  policyFile?: string;

  /** Path to the committed install inventory file. Defaults to 'capwarden-inventory.json'. */
  inventoryFile?: string;
}

const CONFIG_FILES = ['capwarden.config.json', '.capwardenrc'];

/** Load config from the given directory (defaults to cwd). Returns defaults if not found. */
export function loadConfig(dir: string = process.cwd()): CapWardenConfig {
  for (const filename of CONFIG_FILES) {
    const filepath = path.join(dir, filename);
    if (fs.existsSync(filepath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as CapWardenConfig;
        return { onViolation: 'block', ...raw };
      } catch (err) {
        console.error(`[CapWarden] Failed to parse config at ${filepath}: ${String(err)}`);
      }
    }
  }
  return { onViolation: 'block' };
}

/** Return the resolved path to the policy file. */
export function resolvePolicyPath(config: CapWardenConfig, dir: string = process.cwd()): string {
  return path.resolve(dir, config.policyFile ?? 'capwarden-policy.json');
}

/** Return the resolved path to the inventory file. */
export function resolveInventoryPath(config: CapWardenConfig, dir: string = process.cwd()): string {
  return path.resolve(dir, config.inventoryFile ?? 'capwarden-inventory.json');
}
