/**
 * Update mode — runs a fresh observe pass then diffs against the committed policy.
 *
 * Prints the diff clearly separating added capabilities (signal) from removed.
 * Does NOT auto-commit (FR-6).
 */

import * as fs from 'fs';
import type { AccessLog } from '../types.js';
import {
  createEnvInterceptor,
  createFsInterceptor,
  createNetInterceptor,
  createProcInterceptor,
  type Interceptor,
} from '../interceptors/index.js';
import { generateV1Policy } from '../policy/generate.js';
import { diffPolicies, hasAdditions } from '../policy/diff.js';
import { parseV1, serializeV1, type PolicyV1 } from '../policy/schema-v1.js';
import { renderPolicyDiff } from '../report/terminal.js';
import { installFlushHooks } from './flush-hooks.js';

export interface UpdateModeOptions {
  /** Path to the committed policy file. */
  policyPath: string;
  /** Exit non-zero if additions are found (suitable for CI review gates). */
  failOnAdditions?: boolean;
  /**
   * Write the regenerated policy back to `policyPath` after showing the diff
   * (FR-6). Never auto-commits — the user reviews the diff and commits.
   */
  write?: boolean;
}

export function startUpdateMode(options: UpdateModeOptions): () => void {
  const log: AccessLog = [];

  const interceptors: Interceptor[] = [
    createEnvInterceptor({ log }),
    createNetInterceptor({ log }),
    createFsInterceptor({ log }),
    createProcInterceptor({ log }),
  ];

  for (const interceptor of interceptors) {
    interceptor.install();
  }

  let flushed = false;
  const flush = () => {
    if (flushed) return;
    flushed = true;

    for (const interceptor of interceptors) {
      interceptor.uninstall();
    }

    let oldPolicy: PolicyV1;
    try {
      oldPolicy = parseV1(fs.readFileSync(options.policyPath, 'utf-8'));
    } catch {
      console.error(`[CapWarden] Could not read committed policy at ${options.policyPath}`);
      console.error(`  Run 'capwarden observe' first to generate an initial policy.`);
      process.exitCode = 1;
      return;
    }

    const newPolicy = generateV1Policy(log);
    const diff = diffPolicies(oldPolicy, newPolicy);

    renderPolicyDiff(diff);

    if (options.write) {
      fs.writeFileSync(options.policyPath, serializeV1(newPolicy), 'utf-8');
      console.error(`[CapWarden] Regenerated policy written → ${options.policyPath}`);
      console.error(`  Review the diff above, then commit the updated policy.\n`);
    }

    if (options.failOnAdditions && hasAdditions(diff)) {
      process.exitCode = 1;
    }
  };

  installFlushHooks(flush);
  return flush;
}
