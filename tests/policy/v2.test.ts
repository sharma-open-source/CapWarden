/**
 * FR-10: v2 (strict, sub-detail) policy generation, migration, and matching.
 */

import { describe, it, expect } from 'vitest';
import type { AccessLog } from '../../src/types';
import { generateV2Policy } from '../../src/policy/generate-v2';
import {
  isGrantedV2,
  migrateV1ToV2,
  findPackageEntry,
  parseV2,
  serializeV2,
} from '../../src/policy/schema-v2';
import { subDetailToken, parsePackageKey } from '../../src/policy/detail-token';
import { parsePolicy } from '../../src/policy/load';
import type { PolicyV1 } from '../../src/policy/schema-v1';

const log: AccessLog = [
  { packageName: 'leaky', detail: { kind: 'env', key: 'API_KEY' }, timestamp: 0 },
  { packageName: 'leaky', detail: { kind: 'net', host: 'evil.example.com', port: 443 }, timestamp: 0 },
  { packageName: 'leaky', detail: { kind: 'net', host: 'evil.example.com', port: 443 }, timestamp: 0 },
  { packageName: 'app', detail: { kind: 'env', key: 'HOME' }, timestamp: 0 },
];

describe('subDetailToken', () => {
  it('renders the value portion per kind (no kind prefix)', () => {
    expect(subDetailToken({ kind: 'env', key: 'X' })).toBe('X');
    expect(subDetailToken({ kind: 'net', host: 'h', port: 80 })).toBe('h:80');
    expect(subDetailToken({ kind: 'fs', path: '/p', mode: 'write' })).toBe('write:/p');
    expect(subDetailToken({ kind: 'proc', command: 'ls' })).toBe('ls');
  });
});

describe('parsePackageKey', () => {
  it('splits name@version but not a leading scope @', () => {
    expect(parsePackageKey('undici@6.1.0')).toEqual({ name: 'undici', version: '6.1.0' });
    expect(parsePackageKey('@scope/pkg@2.0.0')).toEqual({ name: '@scope/pkg', version: '2.0.0' });
    expect(parsePackageKey('plain')).toEqual({ name: 'plain' });
  });
});

describe('generateV2Policy', () => {
  it('excludes app and pins tokens under strict', () => {
    const p = generateV2Policy(log, { strict: true, generatedAt: 't' });
    expect(Object.keys(p.packages)).toEqual(['leaky']);
    expect(p.packages['leaky'].strict).toBe(true);
    expect(p.packages['leaky'].grants).toEqual({
      env: ['API_KEY'],
      net: ['evil.example.com:443'],
    });
  });

  it('emits wildcard grants in lax mode', () => {
    const p = generateV2Policy(log, { strict: false, generatedAt: 't' });
    expect(p.packages['leaky'].grants).toEqual({ env: ['*'], net: ['*'] });
  });

  it('keys by name@version and records provenance + install flag', () => {
    const p = generateV2Policy(log, {
      strict: true,
      resolveVersion: () => '1.2.3',
      resolveChain: () => ['app > leaky'],
      hasInstallScript: () => true,
      generatedAt: 't',
    });
    const entry = p.packages['leaky@1.2.3'];
    expect(entry).toBeDefined();
    expect(entry.resolvedVia).toEqual(['app > leaky']);
    expect(entry.hasInstallScript).toBe(true);
  });
});

describe('isGrantedV2', () => {
  it('strict: only the pinned token matches', () => {
    const p = generateV2Policy(log, { strict: true, generatedAt: 't' });
    expect(isGrantedV2(p, 'leaky', 'net', 'evil.example.com:443')).toBe(true);
    expect(isGrantedV2(p, 'leaky', 'net', 'other.example.com:443')).toBe(false);
    expect(isGrantedV2(p, 'leaky', 'fs', 'read:/x')).toBe(false);
    expect(isGrantedV2(p, 'unknown', 'env', 'API_KEY')).toBe(false);
  });

  it('strict: a DNS lookup (host:0) is allowed when the host is granted on some port', () => {
    const p = generateV2Policy(log, { strict: true, generatedAt: 't' });
    expect(isGrantedV2(p, 'leaky', 'net', 'evil.example.com:0')).toBe(true);
    expect(isGrantedV2(p, 'leaky', 'net', 'other.example.com:0')).toBe(false);
  });

  it('lax: any token for a granted kind matches', () => {
    const p = generateV2Policy(log, { strict: false, generatedAt: 't' });
    expect(isGrantedV2(p, 'leaky', 'net', 'anything:1')).toBe(true);
    expect(isGrantedV2(p, 'leaky', 'proc', 'ls')).toBe(false); // kind not granted
  });

  it('matches name@version keys by name when version omitted', () => {
    const p = generateV2Policy(log, { strict: true, resolveVersion: () => '9.9.9', generatedAt: 't' });
    expect(findPackageEntry(p, 'leaky')).toBeDefined();
    expect(isGrantedV2(p, 'leaky', 'env', 'API_KEY')).toBe(true);
    expect(isGrantedV2(p, 'leaky', 'env', 'API_KEY', '9.9.9')).toBe(true);
  });
});

describe('migrateV1ToV2', () => {
  it('is behavior-preserving: wildcards, lax, no new blocks', () => {
    const v1: PolicyV1 = { version: 1, packages: { leaky: ['env', 'net'] } };
    const v2 = migrateV1ToV2(v1, 't');
    expect(v2.version).toBe(2);
    expect(v2.packages['leaky'].strict).toBe(false);
    expect(v2.packages['leaky'].grants).toEqual({ env: ['*'], net: ['*'] });
    // Any sub-detail of a granted kind is allowed, matching v1 semantics.
    expect(isGrantedV2(v2, 'leaky', 'net', 'whatever:443')).toBe(true);
    expect(isGrantedV2(v2, 'leaky', 'proc', 'ls')).toBe(false);
  });
});

describe('serializeV2 / parsePolicy round-trip', () => {
  it('parsePolicy detects v2 by version and parses it', () => {
    const p = generateV2Policy(log, { strict: true, generatedAt: 't' });
    const round = parsePolicy(serializeV2(p));
    expect(round.version).toBe(2);
    expect(parseV2(serializeV2(p)).packages['leaky'].grants.env).toEqual(['API_KEY']);
  });

  it('parsePolicy still parses v1 by default', () => {
    const round = parsePolicy(JSON.stringify({ version: 1, packages: { a: ['env'] } }));
    expect(round.version).toBe(1);
  });
});
