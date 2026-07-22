/**
 * Enforce mode — loads the committed policy and blocks any access not permitted.
 *
 * On a violation:
 *   (a) logs a specific message: package, capability, sub-detail, frozen grants
 *   (b) blocks the action (return undefined for env, throw for net/fs/proc)
 *   (c) schedules a non-zero exit for CI (FR-5, FR-17)
 *
 * Fail-open by default (NFR-4): a CapWarden internal error logs and does not block.
 */

import type { AccessEvent, AccessLog, CapabilityKind } from '../types.js';
import {
  createEnvInterceptor,
  createFsInterceptor,
  createNetInterceptor,
  createProcInterceptor,
  type Interceptor,
} from '../interceptors/index.js';
import { installModuleLoadPatch } from '../attribution/async-context.js';
import { isGranted, type PolicyV1 } from '../policy/schema-v1.js';
import { findPackageEntry, isGrantedV2, type PolicyV2 } from '../policy/schema-v2.js';
import { subDetailToken } from '../policy/detail-token.js';
import { CapWardenViolationError } from '../errors.js';
import type { InternalErrorMode } from '../interceptors/guard.js';

export interface EnforceModeOptions {
  /** The committed policy. Both v1 (kind-level) and v2 (strict sub-detail) are supported. */
  policy: PolicyV1 | PolicyV2;
  /**
   * What to do when a package attempts a capability its policy does not grant.
   * 'block' (default): throw / return undefined + schedule non-zero exit.
   * 'log': warn only, never block (fail-open for production safety).
   *
   * This governs *policy violations*. It is distinct from `onInternalError`,
   * which governs bugs in CapWarden itself (NFR-4).
   */
  onViolation?: 'block' | 'log';
  /**
   * What to do when CapWarden's own logic (attribution, policy eval) throws.
   * 'fail-open' (default): log once and let the host operation proceed, so a
   * guard bug never takes down the application. 'fail-closed': rethrow.
   */
  onInternalError?: InternalErrorMode;
  /**
   * Packages to ignore entirely — always allowed, never blocked (FR-19).
   * Use sparingly; their accesses are not enforced.
   */
  ignored?: string[];
  /**
   * Manual pre-deny overrides layered on top of the policy (FR-20): capability
   * kinds a package may NOT use even if the generated policy grants them. The
   * '*' key applies to every package. A denied kind always blocks.
   */
  denied?: Partial<Record<string, CapabilityKind[]>>;
}

let _violationScheduled = false;

export function startEnforceMode(options: EnforceModeOptions): () => void {
  const { policy, onViolation = 'block', onInternalError = 'fail-open' } = options;
  const log: AccessLog = [];

  const ignoredSet = new Set(options.ignored ?? []);
  const denied = options.denied ?? {};
  const isDenied = (pkg: string, kind: CapabilityKind): boolean =>
    (denied['*'] ?? []).includes(kind) || (denied[pkg] ?? []).includes(kind);

  const isGrantedFor = (event: AccessEvent, kind: CapabilityKind): boolean =>
    policy.version === 2
      ? isGrantedV2(policy, event.packageName, kind, subDetailToken(event.detail))
      : isGranted(policy, event.packageName, kind);

  const frozenGrants = (packageName: string): string => {
    if (policy.version === 2) {
      const entry = findPackageEntry(policy, packageName);
      if (!entry) return '(none)';
      return (
        Object.entries(entry.grants)
          .map(([k, tokens]) => (entry.strict ? `${k}(${(tokens ?? []).join('|')})` : k))
          .join(', ') || '(none)'
      );
    }
    return policy.packages[packageName]?.join(', ') || '(none)';
  };

  // Install GA attribution patch so future require()s set async context
  installModuleLoadPatch();

  const handleAccess = (event: AccessEvent): void => {
    if (event.packageName === 'app') return;
    if (ignoredSet.has(event.packageName)) return; // FR-19: always allowed

    const kind = event.detail.kind;
    const denyOverride = isDenied(event.packageName, kind); // FR-20: pre-deny
    const granted = !denyOverride && isGrantedFor(event, kind);
    if (granted) return;

    const frozen = frozenGrants(event.packageName);
    const detail = formatDetail(event);

    const reason = denyOverride
      ? `→ '${kind}' is explicitly denied for ${event.packageName} by a config override.`
      : `→ this capability was never part of ${event.packageName}'s frozen behavior.`;

    const message =
      `\n⛔  CAPWARDEN BLOCKED\n` +
      `     package : ${event.packageName}\n` +
      `     tried   : ${detail}\n` +
      `     policy  : ${frozen === '(none)' ? '(package unknown to policy — zero capabilities)' : `grants [${frozen}]`}\n` +
      `     ${reason}\n`;

    if (onViolation === 'log') {
      console.error(message);
      return;
    }

    console.error(message);

    if (!_violationScheduled) {
      _violationScheduled = true;
      process.exitCode = 1;
    }

    // Signal callers to block the action
    throw new CapWardenViolationError(event.packageName, detail);
  };

  const interceptors: Interceptor[] = [
    createEnvInterceptor({ log, onAccess: handleAccess, onInternalError }),
    createNetInterceptor({ log, onAccess: handleAccess, onInternalError }),
    createFsInterceptor({ log, onAccess: handleAccess, onInternalError }),
    createProcInterceptor({ log, onAccess: handleAccess, onInternalError }),
  ];

  for (const interceptor of interceptors) {
    interceptor.install();
  }

  return () => {
    for (const interceptor of interceptors) {
      interceptor.uninstall();
    }
    _violationScheduled = false;
  };
}

// Re-exported for compatibility; defined in the dependency-free errors module.
export { CapWardenViolationError } from '../errors.js';

function formatDetail(event: AccessEvent): string {
  switch (event.detail.kind) {
    case 'env':
      return `env:${event.detail.key}`;
    case 'net':
      return `net:${event.detail.host}:${event.detail.port}`;
    case 'fs':
      return `fs:${event.detail.mode}:${event.detail.path}`;
    case 'proc':
      return `proc:${event.detail.command}`;
    case 'install':
      return `install:${event.detail.script}`;
  }
}
