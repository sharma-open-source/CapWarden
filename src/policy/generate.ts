/**
 * Generate a v1 policy from an access log.
 *
 * Groups all observed accesses by package name, collects the unique capability
 * kinds used, and emits a normalized v1 policy.  First-party 'app' accesses
 * are excluded — CapWarden governs dependencies, not your own code (FR-12).
 */

import type { AccessLog, CapabilityKind } from '../types.js';
import { normalizeV1, type PolicyV1 } from './schema-v1.js';

export function generateV1Policy(log: AccessLog): PolicyV1 {
  const packages: Record<string, Set<CapabilityKind>> = {};

  for (const event of log) {
    if (event.packageName === 'app') continue;

    if (!packages[event.packageName]) {
      packages[event.packageName] = new Set();
    }
    packages[event.packageName].add(event.detail.kind);
  }

  const flat: Record<string, CapabilityKind[]> = {};
  for (const [pkg, kinds] of Object.entries(packages)) {
    flat[pkg] = [...kinds];
  }

  return normalizeV1({ version: 1, packages: flat });
}
