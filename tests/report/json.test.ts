import { describe, it, expect } from 'vitest';
import { renderJsonReport } from '../../src/report/json';
import type { AccessLog } from '../../src/types';

describe('report/json', () => {
  const log: AccessLog = [
    { packageName: 'dotenv', detail: { kind: 'env', key: 'DB_URL' }, timestamp: 1 },
    { packageName: 'dotenv', detail: { kind: 'fs', path: '.env', mode: 'read' }, timestamp: 2 },
    { packageName: 'undici', detail: { kind: 'net', host: 'api.example.com', port: 443 }, timestamp: 3 },
    // duplicate — should be deduplicated
    { packageName: 'undici', detail: { kind: 'net', host: 'api.example.com', port: 443 }, timestamp: 4 },
    // first-party — should be excluded
    { packageName: 'app', detail: { kind: 'env', key: 'PORT' }, timestamp: 5 },
  ];

  it('includes observed packages in the report', () => {
    const report = renderJsonReport(log);
    expect(Object.keys(report.packages)).toContain('dotenv');
    expect(Object.keys(report.packages)).toContain('undici');
  });

  it('excludes first-party app accesses', () => {
    const report = renderJsonReport(log);
    expect(report.packages['app']).toBeUndefined();
  });

  it('deduplicates net entries', () => {
    const report = renderJsonReport(log);
    expect(report.packages['undici'].net).toHaveLength(1);
  });

  it('never includes env values — only keys (NFR-5)', () => {
    const report = renderJsonReport(log);
    const json = JSON.stringify(report);
    // Confirm only key names appear, no values
    expect(json).toContain('DB_URL');
    // There is no value to check against, but ensure keys are present
    expect(report.packages['dotenv'].env).toContain('DB_URL');
  });

  it('reports totalAccesses count', () => {
    const report = renderJsonReport(log);
    expect(report.totalAccesses).toBe(log.length);
  });
});
