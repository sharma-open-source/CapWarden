import { describe, it, expect } from 'vitest';
import { diffPolicies, hasAdditions } from '../../src/policy/diff';
import type { PolicyV1 } from '../../src/policy/schema-v1';

const base: PolicyV1 = {
  version: 1,
  packages: {
    'dotenv': ['env', 'fs'],
    'undici': ['net'],
  },
};

describe('policy/diff', () => {
  it('reports no changes for identical policies', () => {
    const diff = diffPolicies(base, base);
    expect(diff.newPackages).toHaveLength(0);
    expect(diff.removedPackages).toHaveLength(0);
    expect(diff.changedPackages).toHaveLength(0);
    expect(hasAdditions(diff)).toBe(false);
  });

  it('detects a new package as newPackages', () => {
    const next: PolicyV1 = {
      version: 1,
      packages: { ...base.packages, 'tiny-format': ['env', 'net'] },
    };
    const diff = diffPolicies(base, next);
    expect(diff.newPackages).toContain('tiny-format');
    expect(hasAdditions(diff)).toBe(true);
  });

  it('detects a removed package as removedPackages', () => {
    const next: PolicyV1 = { version: 1, packages: { 'dotenv': ['env', 'fs'] } };
    const diff = diffPolicies(base, next);
    expect(diff.removedPackages).toContain('undici');
    expect(hasAdditions(diff)).toBe(false);
  });

  it('detects an added capability kind in changedPackages', () => {
    const next: PolicyV1 = {
      version: 1,
      packages: { ...base.packages, 'dotenv': ['env', 'fs', 'net'] },
    };
    const diff = diffPolicies(base, next);
    const changed = diff.changedPackages.find((c) => c.packageName === 'dotenv');
    expect(changed).toBeDefined();
    expect(changed?.added).toContain('net');
    expect(hasAdditions(diff)).toBe(true);
  });

  it('detects a removed capability kind in changedPackages', () => {
    const next: PolicyV1 = {
      version: 1,
      packages: { ...base.packages, 'dotenv': ['env'] }, // 'fs' removed
    };
    const diff = diffPolicies(base, next);
    const changed = diff.changedPackages.find((c) => c.packageName === 'dotenv');
    expect(changed?.removed).toContain('fs');
    expect(hasAdditions(diff)).toBe(false);
  });
});
