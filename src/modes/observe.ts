/**
 * Observe mode — records all intercepted accesses, blocks nothing.
 *
 * On process exit writes:
 *   - capwarden-report.json  (machine-readable access log)
 *   - capwarden-policy.json  (proposed v1 policy for review & commit)
 *
 * FR-4, FR-16.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AccessLog } from '../types.js';
import {
  createEnvInterceptor,
  createFsInterceptor,
  createNetInterceptor,
  createProcInterceptor,
  type Interceptor,
} from '../interceptors/index.js';
import { installModuleLoadPatch } from '../attribution/async-context.js';
import { generateV1Policy } from '../policy/generate.js';
import { serializeV1 } from '../policy/schema-v1.js';
import { generateV2Policy } from '../policy/generate-v2.js';
import { serializeV2 } from '../policy/schema-v2.js';
import { makePackageMetaResolvers } from '../policy/package-meta.js';
import { renderJsonReport } from '../report/json.js';
import { installFlushHooks } from './flush-hooks.js';
import { createEventSink } from './event-sink.js';

export interface ObserveModeOptions {
  /** Directory to write output files into. Defaults to process.cwd(). */
  outputDir?: string;
  /** Report filename. Defaults to 'capwarden-report.json'. */
  reportFile?: string;
  /** Policy filename. Defaults to 'capwarden-policy.json'. */
  policyFile?: string;
  /** Policy schema to emit. Defaults to 'v1' (kind-level). */
  schema?: 'v1' | 'v2';
  /** For v2: pin exact sub-detail tokens (strict). Ignored for v1. */
  strict?: boolean;
}

export function startObserveMode(options: ObserveModeOptions = {}): () => void {
  const log: AccessLog = [];
  const outputDir = options.outputDir ?? process.cwd();
  const reportFile = path.join(outputDir, options.reportFile ?? 'capwarden-report.json');
  const policyFile = path.join(outputDir, options.policyFile ?? 'capwarden-policy.json');
  const schema = options.schema ?? 'v1';

  // Before interceptor install: mints CAPWARDEN_RUN_ID so nested Node
  // processes join this run instead of overwriting its outputs.
  const sink = createEventSink();

  // Install GA attribution patch so subsequent require()s set async context
  installModuleLoadPatch();

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

    // Persist this process's events; only the root (outermost) process — which
    // exits last and therefore sees the complete union — writes the outputs.
    const merged = sink.flush(log);
    if (!sink.isRoot) return;

    const report = renderJsonReport(merged);
    let serialized: string;
    if (schema === 'v2') {
      const meta = makePackageMetaResolvers(outputDir);
      serialized = serializeV2(
        generateV2Policy(merged, {
          strict: options.strict,
          resolveVersion: meta.resolveVersion,
          hasInstallScript: meta.hasInstallScript,
        })
      );
    } else {
      serialized = serializeV1(generateV1Policy(merged));
    }

    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf-8');
    fs.writeFileSync(policyFile, serialized, 'utf-8');
    sink.cleanup();

    console.error(`\n[CapWarden] Observe complete.`);
    console.error(`  Report  → ${reportFile}`);
    console.error(`  Policy  → ${policyFile}`);
    console.error(`  Review the policy then commit it as your capability baseline.\n`);
  };

  installFlushHooks(flush);

  // Return manual flush for programmatic use
  return flush;
}
