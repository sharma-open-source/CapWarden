/**
 * v2 versioned + strict policy schema (GA).
 *
 * {
 *   "version": 2,
 *   "generatedAt": "2026-07-21T00:00:00Z",
 *   "defaults": { "strict": false, "onViolation": "block" },
 *   "packages": {
 *     "undici@6.19.2": {
 *       "grants": { "net": ["*"] },
 *       "strict": false,
 *       "resolvedVia": ["app > @sentry/node > undici"]
 *     }
 *   }
 * }
 */

import type { CapabilityKind } from '../types.js';
import type { PolicyV1 } from './schema-v1.js';
import { parsePackageKey } from './detail-token.js';

export type ViolationBehavior = 'block' | 'log';

/** Wildcard grant token: any sub-detail is permitted for the kind. */
export const WILDCARD = '*';

export interface PackageGrantsV2 {
  grants: Partial<Record<CapabilityKind, string[]>>;
  strict: boolean;
  resolvedVia?: string[];
  hasInstallScript?: boolean;
}

export interface PolicyV2Defaults {
  strict: boolean;
  onViolation: ViolationBehavior;
}

export interface PolicyV2 {
  version: 2;
  generatedAt: string;
  defaults: PolicyV2Defaults;
  packages: Record<string, PackageGrantsV2>;
}

/** Read and parse a v2 policy from a JSON string. */
export function parseV2(json: string): PolicyV2 {
  const raw = JSON.parse(json) as unknown;
  assertV2(raw);
  return raw;
}

/** Serialize a v2 policy to a normalized, deterministic JSON string. */
export function serializeV2(policy: PolicyV2): string {
  return JSON.stringify(normalizeV2(policy), null, 2);
}

/** Return a new policy with packages sorted and grant arrays sorted. */
export function normalizeV2(policy: PolicyV2): PolicyV2 {
  const sortedPackages: Record<string, PackageGrantsV2> = {};
  for (const pkg of Object.keys(policy.packages).sort()) {
    const entry = policy.packages[pkg];
    const sortedGrants: Partial<Record<CapabilityKind, string[]>> = {};
    for (const kind of (Object.keys(entry.grants) as CapabilityKind[]).sort()) {
      sortedGrants[kind] = [...(entry.grants[kind] ?? [])].sort();
    }
    sortedPackages[pkg] = { ...entry, grants: sortedGrants };
  }
  return { ...policy, packages: sortedPackages };
}

/**
 * Migrate a v1 (kind-only) policy to v2. Every granted kind becomes a wildcard
 * grant and every package is lax (`strict: false`), so a migrated policy is
 * behaviorally identical to the v1 it came from — no new blocks (FR-10).
 */
export function migrateV1ToV2(v1: PolicyV1, generatedAt?: string): PolicyV2 {
  const packages: Record<string, PackageGrantsV2> = {};
  for (const [name, kinds] of Object.entries(v1.packages)) {
    const grants: Partial<Record<CapabilityKind, string[]>> = {};
    for (const kind of kinds) grants[kind] = [WILDCARD];
    packages[name] = { grants, strict: false };
  }
  return normalizeV2({
    version: 2,
    generatedAt: generatedAt ?? new Date().toISOString(),
    defaults: { strict: false, onViolation: 'block' },
    packages,
  });
}

/**
 * Find the grant entry for a package by *name*, tolerating `name@version` keys.
 * An exact `name@version` match wins; otherwise the first key whose name-part
 * matches is returned. Returns undefined when the package is unknown.
 */
export function findPackageEntry(
  policy: PolicyV2,
  packageName: string,
  version?: string
): PackageGrantsV2 | undefined {
  if (version && policy.packages[`${packageName}@${version}`]) {
    return policy.packages[`${packageName}@${version}`];
  }
  if (policy.packages[packageName]) return policy.packages[packageName];
  for (const [key, entry] of Object.entries(policy.packages)) {
    if (parsePackageKey(key).name === packageName) return entry;
  }
  return undefined;
}

/**
 * Decide whether a v2 policy grants an access. In lax mode, the presence of the
 * capability kind is sufficient (v1-compatible). In strict mode, the exact
 * sub-detail token must be pinned — unless a wildcard (`*`) token is present.
 */
export function isGrantedV2(
  policy: PolicyV2,
  packageName: string,
  kind: CapabilityKind,
  token: string,
  version?: string
): boolean {
  const entry = findPackageEntry(policy, packageName, version);
  if (!entry) return false;
  const kindGrants = entry.grants[kind];
  if (!kindGrants) return false;
  if (kindGrants.includes(WILDCARD)) return true;
  if (!entry.strict) return true; // lax: kind present is enough
  if (kindGrants.includes(token)) return true;

  // A DNS lookup is recorded as `host:0` (no connection port). Resolving a host
  // the package may already reach on some port is not a separate violation, so
  // a `host:0` token is granted whenever any `host:<port>` grant exists.
  if (kind === 'net' && token.endsWith(':0')) {
    const host = token.slice(0, -':0'.length);
    return kindGrants.some((g) => g.startsWith(`${host}:`));
  }
  return false;
}

function assertV2(value: unknown): asserts value is PolicyV2 {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as PolicyV2).version !== 2 ||
    typeof (value as PolicyV2).packages !== 'object'
  ) {
    throw new Error('Invalid CapWarden v2 policy: missing version:2 or packages object');
  }
}
