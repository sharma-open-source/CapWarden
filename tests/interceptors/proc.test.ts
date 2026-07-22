import { describe, it, expect, beforeEach } from 'vitest';
// Use require() to get the actual mutable CJS module object (not the ESM namespace wrapper)
/* eslint-disable @typescript-eslint/no-require-imports */
import type * as childProcessType from 'child_process';
const childProcess = require('child_process') as typeof childProcessType;
/* eslint-enable @typescript-eslint/no-require-imports */
import { createProcInterceptor } from '../../src/interceptors/proc';
import { CapWardenViolationError } from '../../src/errors';
import type { AccessLog } from '../../src/types';

describe('interceptors/proc', () => {
  let log: AccessLog;

  beforeEach(() => {
    log = [];
  });

  it('replaces child_process.exec on install', () => {
    const orig = childProcess.exec;
    const interceptor = createProcInterceptor({ log });
    interceptor.install();
    expect(childProcess.exec).not.toBe(orig);
    interceptor.uninstall();
  });

  it('restores all original functions on uninstall', () => {
    const origExec = childProcess.exec;
    const origSpawn = childProcess.spawn;
    const origFork = childProcess.fork;
    const origExecSync = childProcess.execSync;

    const interceptor = createProcInterceptor({ log });
    interceptor.install();
    interceptor.uninstall();

    expect(childProcess.exec).toBe(origExec);
    expect(childProcess.spawn).toBe(origSpawn);
    expect(childProcess.fork).toBe(origFork);
    expect(childProcess.execSync).toBe(origExecSync);
  });

  it('records execSync command into the log', () => {
    const interceptor = createProcInterceptor({ log });
    interceptor.install();
    try {
      childProcess.execSync('echo hello', { stdio: 'pipe' });
      const event = log.find(
        (e) => e.detail.kind === 'proc' && e.detail.command === 'echo hello'
      );
      expect(event).toBeDefined();
    } finally {
      interceptor.uninstall();
    }
  });

  it('records spawn command into the log', () => {
    const interceptor = createProcInterceptor({ log });
    interceptor.install();
    try {
      const child = childProcess.spawn('echo', ['world'], { stdio: 'pipe' });
      child.kill();
      const event = log.find((e) => e.detail.kind === 'proc' && e.detail.command === 'echo');
      expect(event).toBeDefined();
    } finally {
      interceptor.uninstall();
    }
  });

  it('throws when onAccess signals a block (enforce mode)', () => {
    const interceptor = createProcInterceptor({
      log,
      onAccess: (event) => {
        if (event.detail.kind === 'proc') {
          throw new CapWardenViolationError('pkg', 'proc:echo hi');
        }
      },
    });
    interceptor.install();
    try {
      expect(() => childProcess.execSync('echo hi', { stdio: 'pipe' })).toThrow(
        CapWardenViolationError
      );
    } finally {
      interceptor.uninstall();
    }
  });

  it('fails open (does NOT block) when CapWarden itself errors (NFR-4)', () => {
    // A non-violation error thrown from onAccess is a CapWarden bug, not a
    // block signal: the host command must still run.
    const interceptor = createProcInterceptor({
      log,
      onAccess: () => {
        throw new Error('simulated internal bug');
      },
    });
    interceptor.install();
    try {
      const out = childProcess.execSync('echo ok', { stdio: 'pipe' }).toString();
      expect(out).toContain('ok');
    } finally {
      interceptor.uninstall();
    }
  });

  it('calls onAccess with the proc event details', () => {
    const seen: string[] = [];
    const interceptor = createProcInterceptor({
      log,
      onAccess: (event) => {
        if (event.detail.kind === 'proc') seen.push(event.detail.command);
      },
    });
    interceptor.install();
    try {
      childProcess.execSync('echo callback-test', { stdio: 'pipe' });
      expect(seen).toContain('echo callback-test');
    } finally {
      interceptor.uninstall();
    }
  });

  it('is idempotent — double install does not double-wrap', () => {
    const interceptor = createProcInterceptor({ log });
    interceptor.install();
    const wrapped = childProcess.exec;
    interceptor.install();
    expect(childProcess.exec).toBe(wrapped);
    interceptor.uninstall();
  });
});
