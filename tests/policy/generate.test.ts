import { describe, it, expect } from 'vitest';
import { generateV1Policy } from '../../src/policy/generate';
import type { AccessLog } from '../../src/types';

describe('policy/generate', () => {
  it('generates a policy from an access log', () => {
    const log: AccessLog = [
      { packageName: 'dotenv', detail: { kind: 'env', key: 'DB_URL' }, timestamp: 1 },
      { packageName: 'dotenv', detail: { kind: 'fs', path: '.env', mode: 'read' }, timestamp: 2 },
      { packageName: 'undici', detail: { kind: 'net', host: 'api.example.com', port: 443 }, timestamp: 3 },
    ];
    const policy = generateV1Policy(log);
    expect(policy.version).toBe(1);
    expect(policy.packages['dotenv']).toContain('env');
    expect(policy.packages['dotenv']).toContain('fs');
    expect(policy.packages['undici']).toContain('net');
  });

  it('excludes first-party app accesses', () => {
    const log: AccessLog = [
      { packageName: 'app', detail: { kind: 'env', key: 'PORT' }, timestamp: 1 },
      { packageName: 'some-lib', detail: { kind: 'net', host: 'api.example.com', port: 443 }, timestamp: 2 },
    ];
    const policy = generateV1Policy(log);
    expect(policy.packages['app']).toBeUndefined();
    expect(policy.packages['some-lib']).toContain('net');
  });

  it('deduplicates capability kinds per package', () => {
    const log: AccessLog = [
      { packageName: 'axios', detail: { kind: 'net', host: 'a.com', port: 443 }, timestamp: 1 },
      { packageName: 'axios', detail: { kind: 'net', host: 'b.com', port: 80 }, timestamp: 2 },
    ];
    const policy = generateV1Policy(log);
    expect(policy.packages['axios'].filter((k) => k === 'net')).toHaveLength(1);
  });

  it('produces a normalized (sorted) policy', () => {
    const log: AccessLog = [
      { packageName: 'z-pkg', detail: { kind: 'fs', path: '/tmp/x', mode: 'write' }, timestamp: 1 },
      { packageName: 'a-pkg', detail: { kind: 'env', key: 'X' }, timestamp: 2 },
    ];
    const policy = generateV1Policy(log);
    const keys = Object.keys(policy.packages);
    expect(keys).toEqual([...keys].sort());
  });

  it('returns an empty packages object for an empty log', () => {
    const policy = generateV1Policy([]);
    expect(Object.keys(policy.packages)).toHaveLength(0);
  });
});
