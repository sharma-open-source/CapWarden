/**
 * Cross-process event aggregation for observe / update runs.
 *
 * `capwarden observe -- npm test` preloads CapWarden into every nested Node
 * process (npm → vitest → workers). Each process records only its own events
 * and flushes on exit — so with a plain overwrite the *parent* (npm), which
 * never sees the test runner's vite/esbuild accesses, exits last and clobbers
 * the complete report its child already wrote. The frozen policy then misses
 * whole packages and enforce blocks them as "unknown to policy".
 *
 * Instead, each observed process persists its raw log to `<runDir>/<pid>.json`
 * and the merged union is what reports and policies are generated from. The
 * run directory is keyed by CAPWARDEN_RUN_ID: the outermost observed process
 * (the root) mints the id, children inherit it via the environment, and since
 * children always exit before the process that spawned them, the root sees the
 * complete union, writes the final outputs, and cleans the directory up.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AccessLog } from '../types.js';

export interface EventSink {
  /** True when this process minted the run id (outermost observed process). */
  readonly isRoot: boolean;
  /** Persist this process's log, then return the merged log for the run. */
  flush(log: AccessLog): AccessLog;
  /** Remove the run directory. No-op in child processes. */
  cleanup(): void;
}

/**
 * Must be called before the interceptors install (it touches process.env and
 * the filesystem) and before any child process can be spawned.
 */
export function createEventSink(): EventSink {
  const inherited = process.env['CAPWARDEN_RUN_ID'] || undefined;
  const runId = inherited ?? `${Date.now().toString(36)}-${process.pid}`;
  if (!inherited) process.env['CAPWARDEN_RUN_ID'] = runId; // children inherit
  const runDir = path.join(os.tmpdir(), `capwarden-run-${runId}`);
  const isRoot = !inherited;

  return {
    isRoot,

    flush(log: AccessLog): AccessLog {
      try {
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, `${process.pid}.json`), JSON.stringify(log), 'utf-8');

        const merged: AccessLog = [];
        for (const file of fs.readdirSync(runDir)) {
          if (!file.endsWith('.json')) continue;
          try {
            merged.push(
              ...(JSON.parse(fs.readFileSync(path.join(runDir, file), 'utf-8')) as AccessLog)
            );
          } catch {
            // A sibling may still be mid-write; its parent will pick it up.
          }
        }
        merged.sort((a, b) => a.timestamp - b.timestamp);
        return merged;
      } catch {
        // Sink failure must never lose this process's own events.
        return log;
      }
    },

    cleanup(): void {
      if (!isRoot) return;
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        // Best-effort: a stale tmpdir entry is harmless.
      }
    },
  };
}
