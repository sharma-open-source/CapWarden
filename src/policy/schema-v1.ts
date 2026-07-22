/**
 * v1 flat policy schema.
 *
 * {
 *   "version": 1,
 *   "packages": {
 *     "undici": ["net"],
 *     "dotenv": ["env", "fs"]
 *   }
 * }
 *
 * Packages absent from `packages` have zero capabilities.
 */

import type { CapabilityKind } from '../types.js';

export interface PolicyV1 {
  version: 1;
  packages: Record<string, CapabilityKind[]>;
}

/** Read and parse a v1 policy from a JSON string. */
export function parseV1(json: string): PolicyV1 {
  const raw = JSON.parse(json) as unknown;
  assertV1(raw);
  return raw;
}

/** Serialize a v1 policy to a normalized, deterministic JSON string. */
export function serializeV1(policy: PolicyV1): string {
  return JSON.stringify(normalizeV1(policy), null, 2);
}

/** Return a new policy with packages and capability arrays sorted (deterministic diffs). */
export function normalizeV1(policy: PolicyV1): PolicyV1 {
  const sortedPackages: Record<string, CapabilityKind[]> = {};
  for (const pkg of Object.keys(policy.packages).sort()) {
    sortedPackages[pkg] = [...policy.packages[pkg]].sort() as CapabilityKind[];
  }
  return { version: 1, packages: sortedPackages };
}

/** Return the granted capability kinds for a package (empty array = zero capabilities). */
export function grantsForPackage(policy: PolicyV1, packageName: string): CapabilityKind[] {
  return policy.packages[packageName] ?? [];
}

/** Return true if the package has the given capability kind in the policy. */
export function isGranted(
  policy: PolicyV1,
  packageName: string,
  kind: CapabilityKind
): boolean {
  return grantsForPackage(policy, packageName).includes(kind);
}

function assertV1(value: unknown): asserts value is PolicyV1 {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as PolicyV1).version !== 1 ||
    typeof (value as PolicyV1).packages !== 'object'
  ) {
    throw new Error('Invalid CapWarden v1 policy: missing version:1 or packages object');
  }
}
