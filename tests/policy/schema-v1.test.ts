import { describe, it, expect } from 'vitest';
import { normalizeV1, parseV1, serializeV1, grantsForPackage, isGranted } from '../../src/policy/schema-v1';

describe('policy/schema-v1', () => {
  const raw = {
    version: 1 as const,
    packages: {
      'dotenv': ['env', 'fs'],
      'undici': ['net'],
      '@sentry/node': ['env', 'net'],
    },
  };

  it('parseV1 accepts a valid v1 JSON string', () => {
    const p = parseV1(JSON.stringify(raw));
    expect(p.version).toBe(1);
    expect(p.packages['undici']).toContain('net');
  });

  it('parseV1 throws on invalid schema', () => {
    expect(() => parseV1('{"version":2,"packages":{}}')).toThrow();
    expect(() => parseV1('"not an object"')).toThrow();
  });

  it('normalizeV1 sorts packages and capability arrays', () => {
    const norm = normalizeV1(raw);
    const pkgs = Object.keys(norm.packages);
    expect(pkgs).toEqual([...pkgs].sort());
    expect(norm.packages['dotenv']).toEqual(['env', 'fs'].sort());
    expect(norm.packages['@sentry/node']).toEqual(['env', 'net'].sort());
  });

  it('serializeV1 produces stable output for the same input', () => {
    const a = serializeV1(raw);
    const b = serializeV1(raw);
    expect(a).toBe(b);
  });

  it('grantsForPackage returns empty array for unknown packages', () => {
    const p = parseV1(JSON.stringify(raw));
    expect(grantsForPackage(p, 'unknown-pkg')).toEqual([]);
  });

  it('isGranted returns true for permitted capability', () => {
    const p = parseV1(JSON.stringify(raw));
    expect(isGranted(p, 'undici', 'net')).toBe(true);
    expect(isGranted(p, 'dotenv', 'env')).toBe(true);
  });

  it('isGranted returns false for unpermitted capability', () => {
    const p = parseV1(JSON.stringify(raw));
    expect(isGranted(p, 'undici', 'fs')).toBe(false);
    expect(isGranted(p, 'unknown-pkg', 'env')).toBe(false);
  });
});
