import { describe, it, expect, beforeEach } from 'vitest';
// require() for the real mutable CJS module object
/* eslint-disable @typescript-eslint/no-require-imports */
import type * as childProcessType from 'child_process';
const childProcess = require('child_process') as typeof childProcessType;
/* eslint-enable @typescript-eslint/no-require-imports */
import { createProcInterceptor } from '../../src/interceptors/proc';
import {
  reportInternalError,
  _resetInternalErrorWarning,
} from '../../src/interceptors/guard';
import { CapWardenViolationError } from '../../src/errors';
import type { AccessLog } from '../../src/types';

describe('interceptors/guard — reportInternalError (NFR-4)', () => {
  beforeEach(() => _resetInternalErrorWarning());

  it('rethrows in fail-closed mode', () => {
    const bug = new Error('boom');
    expect(() => reportInternalError(bug, 'fail-closed')).toThrow(bug);
  });

  it('swallows in fail-open mode', () => {
    expect(() => reportInternalError(new Error('boom'), 'fail-open')).not.toThrow();
  });
});

describe('interceptors — internal-error posture end to end (NFR-4)', () => {
  let log: AccessLog;
  beforeEach(() => {
    log = [];
    _resetInternalErrorWarning();
  });

  it('fail-open (default): a CapWarden bug does not block the host command', () => {
    const interceptor = createProcInterceptor({
      log,
      onAccess: () => {
        throw new Error('simulated internal bug'); // not a violation
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

  it('fail-closed: a CapWarden bug propagates to the host', () => {
    const interceptor = createProcInterceptor({
      log,
      onInternalError: 'fail-closed',
      onAccess: () => {
        throw new Error('simulated internal bug');
      },
    });
    interceptor.install();
    try {
      expect(() => childProcess.execSync('echo ok', { stdio: 'pipe' })).toThrow(
        'simulated internal bug'
      );
    } finally {
      interceptor.uninstall();
    }
  });

  it('a real violation still blocks under both postures', () => {
    for (const onInternalError of ['fail-open', 'fail-closed'] as const) {
      const interceptor = createProcInterceptor({
        log,
        onInternalError,
        onAccess: () => {
          throw new CapWardenViolationError('pkg', 'proc:echo ok');
        },
      });
      interceptor.install();
      try {
        expect(() => childProcess.execSync('echo ok', { stdio: 'pipe' })).toThrow(
          CapWardenViolationError
        );
      } finally {
        interceptor.uninstall();
      }
    }
  });
});
