/**
 * Diff two v1 policies.
 *
 * Returns a structured diff that clearly separates added capabilities
 * (the review-worthy signal) from removed ones (FR-18).
 */

import type { CapabilityKind } from '../types.js';
import type { PolicyV1 } from './schema-v1.js';
import { normalizeV1 } from './schema-v1.js';

export interface PackageDiff {
  packageName: string;
  added: CapabilityKind[];
  removed: CapabilityKind[];
}

export interface PolicyDiff {
  /** Packages that appear only in the new policy (brand new capabilities). */
  newPackages: string[];
  /** Packages that appear only in the old policy (fully removed). */
  removedPackages: string[];
  /** Packages present in both but with changed capability sets. */
  changedPackages: PackageDiff[];
}

export function diffPolicies(oldPolicy: PolicyV1, newPolicy: PolicyV1): PolicyDiff {
  const old = normalizeV1(oldPolicy);
  const next = normalizeV1(newPolicy);

  const oldPkgs = new Set(Object.keys(old.packages));
  const newPkgs = new Set(Object.keys(next.packages));

  const newPackages = [...newPkgs].filter((p) => !oldPkgs.has(p));
  const removedPackages = [...oldPkgs].filter((p) => !newPkgs.has(p));
  const changedPackages: PackageDiff[] = [];

  for (const pkg of [...oldPkgs].filter((p) => newPkgs.has(p))) {
    const oldKinds = new Set(old.packages[pkg]);
    const newKinds = new Set(next.packages[pkg]);

    const added = [...newKinds].filter((k) => !oldKinds.has(k)) as CapabilityKind[];
    const removed = [...oldKinds].filter((k) => !newKinds.has(k)) as CapabilityKind[];

    if (added.length > 0 || removed.length > 0) {
      changedPackages.push({ packageName: pkg, added, removed });
    }
  }

  return { newPackages, removedPackages, changedPackages };
}

/** Returns true if the diff has any additions — the CI-relevant signal. */
export function hasAdditions(diff: PolicyDiff): boolean {
  return (
    diff.newPackages.length > 0 ||
    diff.changedPackages.some((c) => c.added.length > 0)
  );
}
