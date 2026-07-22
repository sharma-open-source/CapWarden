import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEnvInterceptor } from '../../src/interceptors/env';
import { CapWardenViolationError } from '../../src/errors';
import type { AccessLog } from '../../src/types';

describe('interceptors/env', () => {
  let log: AccessLog;

  beforeEach(() => {
    log = [];
  });

  afterEach(() => {
    // Interceptors restore process.env in uninstall(); nothing to do here.
  });

  it('records env key reads into the log', () => {
    const interceptor = createEnvInterceptor({ log });
    interceptor.install();
    try {
      process.env['TEST_VAR_CAPWARDEN'] = 'some-value';
      const _ = process.env['TEST_VAR_CAPWARDEN'];
      void _;
      const envEvents = log.filter((e) => e.detail.kind === 'env');
      expect(envEvents.some((e) => e.detail.kind === 'env' && e.detail.key === 'TEST_VAR_CAPWARDEN')).toBe(true);
    } finally {
      interceptor.uninstall();
      delete process.env['TEST_VAR_CAPWARDEN'];
    }
  });

  it('records env writes and deletes as accesses (not just reads)', () => {
    const seen: string[] = [];
    const interceptor = createEnvInterceptor({
      log,
      // Force attribution to a package so onAccess is exercised, and record the
      // key each write/delete is charged to.
      onAccess: (e) => {
        if (e.detail.kind === 'env') seen.push(e.detail.key);
      },
    });
    interceptor.install();
    try {
      process.env['CW_WRITE_KEY'] = '0';
      delete process.env['CW_WRITE_KEY'];
      const writeEvents = log.filter(
        (e) => e.detail.kind === 'env' && e.detail.key === 'CW_WRITE_KEY'
      );
      // At least one event for the write and one for the delete.
      expect(writeEvents.length).toBeGreaterThanOrEqual(2);
    } finally {
      interceptor.uninstall();
      delete process.env['CW_WRITE_KEY'];
    }
  });

  it('blocks a write from a package in enforce mode (withholds the mutation)', () => {
    const interceptor = createEnvInterceptor({
      log,
      onAccess: () => {
        throw new CapWardenViolationError('leaky-pkg', 'env:NODE_TLS_REJECT_UNAUTHORIZED');
      },
    });
    interceptor.install();
    try {
      const before = process.env['CW_ENFORCE_WRITE'];
      // Assignment must not throw (Proxy set invariant) but must not take effect.
      process.env['CW_ENFORCE_WRITE'] = 'tampered';
      expect(process.env['CW_ENFORCE_WRITE']).toBe(before);
    } finally {
      interceptor.uninstall();
      delete process.env['CW_ENFORCE_WRITE'];
    }
  });

  it('never records the env value — only the key (NFR-5)', () => {
    const interceptor = createEnvInterceptor({ log });
    interceptor.install();
    try {
      process.env['SECRET_KEY'] = 'super-secret-value';
      const _ = process.env['SECRET_KEY'];
      void _;
      const json = JSON.stringify(log);
      expect(json).not.toContain('super-secret-value');
      expect(json).toContain('SECRET_KEY');
    } finally {
      interceptor.uninstall();
      delete process.env['SECRET_KEY'];
    }
  });

  it('returns the actual value when not blocked', () => {
    const interceptor = createEnvInterceptor({ log });
    interceptor.install();
    try {
      process.env['CW_TEST'] = 'hello';
      expect(process.env['CW_TEST']).toBe('hello');
    } finally {
      interceptor.uninstall();
      delete process.env['CW_TEST'];
    }
  });

  it('withholds the value when onAccess signals a block for any package', () => {
    // The interceptor withholds the value when onAccess raises a violation.
    // In tests, attribution returns a vitest frame (in node_modules), so
    // we use a blanket onAccess that blocks all packages.
    let blocked = false;
    const interceptor = createEnvInterceptor({
      log,
      onAccess: () => {
        blocked = true;
        throw new CapWardenViolationError('pkg', 'env:BLOCKED_VAR');
      },
    });
    interceptor.install();
    try {
      process.env['BLOCKED_VAR'] = 'secret';
      const value = process.env['BLOCKED_VAR'];
      expect(value).toBeUndefined();
      expect(blocked).toBe(true);
    } finally {
      interceptor.uninstall();
      delete process.env['BLOCKED_VAR'];
    }
  });

  it('fails open (discloses the value) when CapWarden itself errors (NFR-4)', () => {
    // A non-violation error is a CapWarden bug, not a block: the real value
    // must still be returned rather than crashing or withholding.
    const interceptor = createEnvInterceptor({
      log,
      onAccess: () => {
        throw new Error('simulated internal bug');
      },
    });
    interceptor.install();
    try {
      process.env['FAILOPEN_VAR'] = 'visible';
      expect(process.env['FAILOPEN_VAR']).toBe('visible');
    } finally {
      interceptor.uninstall();
      delete process.env['FAILOPEN_VAR'];
    }
  });

  it('withholds the value via getOwnPropertyDescriptor when blocked (GAP §1.1)', () => {
    // The one-line bypass from the gap analysis / PRD §17.3:
    //   Object.getOwnPropertyDescriptors(process.env).X.value
    // must route through the same block path as a plain get.
    const interceptor = createEnvInterceptor({
      log,
      onAccess: () => {
        throw new CapWardenViolationError('pkg', 'env:AWS_SECRET_ACCESS_KEY');
      },
    });
    interceptor.install();
    try {
      process.env['AWS_SECRET_ACCESS_KEY'] = 'topsecret';
      const leaked = Object.getOwnPropertyDescriptors(process.env)[
        'AWS_SECRET_ACCESS_KEY'
      ]?.value;
      expect(leaked).toBeUndefined();
      const logged = log.some(
        (e) => e.detail.kind === 'env' && e.detail.key === 'AWS_SECRET_ACCESS_KEY'
      );
      expect(logged).toBe(true);
    } finally {
      interceptor.uninstall();
      delete process.env['AWS_SECRET_ACCESS_KEY'];
    }
  });

  it('charges an env access when the keyspace is enumerated (GAP §1.1)', () => {
    const interceptor = createEnvInterceptor({ log });
    interceptor.install();
    try {
      Object.keys(process.env);
      const enumerated = log.some((e) => e.detail.kind === 'env' && e.detail.key === '*');
      expect(enumerated).toBe(true);
    } finally {
      interceptor.uninstall();
    }
  });

  it('does not charge a package for Node-internal env keys (GAP §1.4)', () => {
    // FORCE_COLOR is read by Node's own TTY/color machinery. Even with a
    // throwing (block-everything) onAccess, reading it must not be blocked and
    // must be recorded as 'app', not the ambient package.
    const interceptor = createEnvInterceptor({
      log,
      onAccess: () => {
        throw new CapWardenViolationError('pkg', 'env:FORCE_COLOR');
      },
    });
    interceptor.install();
    try {
      process.env['FORCE_COLOR'] = '1';
      const value = process.env['FORCE_COLOR'];
      expect(value).toBe('1'); // not withheld
      const ev = log.find((e) => e.detail.kind === 'env' && e.detail.key === 'FORCE_COLOR');
      expect(ev?.packageName).toBe('app');
    } finally {
      interceptor.uninstall();
      delete process.env['FORCE_COLOR'];
    }
  });

  it('still charges the package for ordinary (non-internal) keys (GAP §1.4)', () => {
    // Guard that the suppression is narrow: a normal secret is still attributed
    // to the ambient package (the vitest node_modules frame here), not 'app'.
    const interceptor = createEnvInterceptor({ log });
    interceptor.install();
    try {
      process.env['MY_APP_SECRET'] = 'x';
      void process.env['MY_APP_SECRET'];
      const ev = log.find((e) => e.detail.kind === 'env' && e.detail.key === 'MY_APP_SECRET');
      expect(ev).toBeDefined();
      expect(ev?.packageName).not.toBe('app');
    } finally {
      interceptor.uninstall();
      delete process.env['MY_APP_SECRET'];
    }
  });

  it('restores original process.env on uninstall', () => {
    const original = process.env;
    const interceptor = createEnvInterceptor({ log });
    interceptor.install();
    expect(process.env).not.toBe(original);
    interceptor.uninstall();
    expect(process.env).toBe(original);
  });

  it('is idempotent — double install does not double-wrap', () => {
    const interceptor = createEnvInterceptor({ log });
    interceptor.install();
    const proxied = process.env;
    interceptor.install(); // should be a no-op
    expect(process.env).toBe(proxied);
    interceptor.uninstall();
  });
});
