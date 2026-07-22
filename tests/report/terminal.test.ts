import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderTerminalReport, renderTerminalReportFromJson } from '../../src/report/terminal';
import type { AccessLog } from '../../src/types';
import type { JsonReport } from '../../src/report/json';

function captureStderr(fn: () => void): string {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map((c) => c.join(' ')).join('\n');
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

describe('renderTerminalReportFromJson (FR-16)', () => {
  it('renders each package and its capabilities', () => {
    const report: JsonReport = {
      generatedAt: '2026-07-22T00:00:00.000Z',
      totalAccesses: 3,
      packages: {
        leaky: {
          env: ['API_KEY'],
          net: ['evil.example.com:443'],
          fs: [{ path: '/etc/passwd', mode: 'read' }],
          proc: [],
          install: [],
        },
      },
    };
    const out = captureStderr(() => renderTerminalReportFromJson(report));
    expect(out).toContain('leaky');
    expect(out).toContain('API_KEY');
    expect(out).toContain('evil.example.com:443');
    expect(out).toContain('read:/etc/passwd');
  });

  it('reports the clean case when nothing was observed', () => {
    const report: JsonReport = { generatedAt: 't', totalAccesses: 0, packages: {} };
    const out = captureStderr(() => renderTerminalReportFromJson(report));
    expect(out).toContain('No dependency accesses recorded');
  });
});

describe('renderTerminalReport (from a live log)', () => {
  it('excludes first-party app accesses', () => {
    const log: AccessLog = [
      { packageName: 'app', detail: { kind: 'env', key: 'HOME' }, timestamp: 0 },
      { packageName: 'dep', detail: { kind: 'env', key: 'TOKEN' }, timestamp: 0 },
    ];
    const out = captureStderr(() => renderTerminalReport(log));
    expect(out).toContain('dep');
    expect(out).toContain('TOKEN');
    expect(out).not.toMatch(/\bapp\b/);
  });
});
