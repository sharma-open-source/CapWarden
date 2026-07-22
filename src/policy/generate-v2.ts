/**
 * Generate a v2 policy from an access log (FR-10).
 *
 * v2 differs from v1 in three ways:
 *   1. Grants carry *sub-detail tokens* (`net` → `host:443`), not just kinds.
 *   2. Each package can be `strict`: in strict mode only the pinned tokens are
 *      allowed; in lax mode the presence of the kind is enough (v1-compatible).
 *   3. Packages are keyed by `name@version` when a version resolver is supplied,
 *      and carry `resolvedVia` provenance and an `hasInstallScript` flag.
 *
 * First-party 'app' accesses are excluded (FR-12).
 */

import type { AccessLog, CapabilityKind } from '../types.js';
import { normalizeV2, type PackageGrantsV2, type PolicyV2, type PolicyV2Defaults } from './schema-v2.js';
import { subDetailToken } from './detail-token.js';

export interface GenerateV2Options {
  /** Default posture applied to packages that don't override it. */
  defaults?: Partial<PolicyV2Defaults>;
  /** When true, every generated package pins its exact sub-detail tokens. */
  strict?: boolean;
  /** Resolve a package name to its installed version, forming a `name@version` key. */
  resolveVersion?: (packageName: string) => string | undefined;
  /** Resolve the dependency path(s) a package was reached through (provenance). */
  resolveChain?: (packageName: string) => string[] | undefined;
  /** Report whether a package declares a lifecycle install script. */
  hasInstallScript?: (packageName: string) => boolean | undefined;
  /** Timestamp for the policy (injectable for deterministic tests). */
  generatedAt?: string;
}

export function generateV2Policy(log: AccessLog, options: GenerateV2Options = {}): PolicyV2 {
  const defaults: PolicyV2Defaults = {
    strict: options.defaults?.strict ?? options.strict ?? false,
    onViolation: options.defaults?.onViolation ?? 'block',
  };

  // Accumulate tokens per (package name, kind).
  const byPackage = new Map<string, Map<CapabilityKind, Set<string>>>();

  for (const event of log) {
    if (event.packageName === 'app') continue;
    let kinds = byPackage.get(event.packageName);
    if (!kinds) {
      kinds = new Map();
      byPackage.set(event.packageName, kinds);
    }
    let tokens = kinds.get(event.detail.kind);
    if (!tokens) {
      tokens = new Set();
      kinds.set(event.detail.kind, tokens);
    }
    tokens.add(subDetailToken(event.detail));
  }

  const strict = options.strict ?? defaults.strict;
  const packages: Record<string, PackageGrantsV2> = {};

  for (const [name, kinds] of byPackage) {
    const version = options.resolveVersion?.(name);
    const key = version ? `${name}@${version}` : name;

    const grants: Partial<Record<CapabilityKind, string[]>> = {};
    for (const [kind, tokens] of kinds) {
      grants[kind] = strict ? [...tokens].sort() : ['*'];
    }

    const entry: PackageGrantsV2 = { grants, strict };
    const chain = options.resolveChain?.(name);
    if (chain && chain.length) entry.resolvedVia = chain;
    const installScript = options.hasInstallScript?.(name);
    if (installScript !== undefined) entry.hasInstallScript = installScript;

    packages[key] = entry;
  }

  return normalizeV2({
    version: 2,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    defaults,
    packages,
  });
}
