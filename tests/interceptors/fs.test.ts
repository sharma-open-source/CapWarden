import { describe, it, expect, beforeEach } from 'vitest';
// Use require() to get the actual mutable CJS module object (not the ESM namespace wrapper)
/* eslint-disable @typescript-eslint/no-require-imports */
import type * as fsType from 'fs';
const fs = require('fs') as typeof fsType;
/* eslint-enable @typescript-eslint/no-require-imports */
import * as os from 'os';
import * as path from 'path';
import { createFsInterceptor } from '../../src/interceptors/fs';
import { CapWardenViolationError } from '../../src/errors';
import type { AccessLog } from '../../src/types';

describe('interceptors/fs', () => {
  let log: AccessLog;
  let tmpDir: string;

  beforeEach(() => {
    log = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capwarden-test-'));
  });

  const cleanup = (interceptor: { uninstall(): void }) => {
    interceptor.uninstall();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  it('records a readFileSync access as read', () => {
    const filePath = path.join(tmpDir, 'read.txt');
    fs.writeFileSync(filePath, 'hello');

    const interceptor = createFsInterceptor({ log });
    interceptor.install();
    try {
      fs.readFileSync(filePath, 'utf-8');
      const event = log.find((e) => e.detail.kind === 'fs' && e.detail.path === filePath);
      expect(event).toBeDefined();
      expect(event?.detail.kind === 'fs' && event.detail.mode).toBe('read');
    } finally {
      cleanup(interceptor);
    }
  });

  it('records a file: URL path decoded, not percent-encoded (spaces in path)', () => {
    const spacedDir = path.join(tmpDir, 'untitled folder');
    fs.mkdirSync(spacedDir);
    const filePath = path.join(spacedDir, 'read.txt');
    fs.writeFileSync(filePath, 'hello');

    const interceptor = createFsInterceptor({ log });
    interceptor.install();
    try {
      fs.readFileSync(new URL(`file://${filePath.replace(/ /g, '%20')}`), 'utf-8');
      const event = log.find((e) => e.detail.kind === 'fs' && e.detail.mode === 'read');
      expect(event?.detail.kind === 'fs' && event.detail.path).toBe(filePath);
    } finally {
      cleanup(interceptor);
    }
  });

  it('records a writeFileSync access as write', () => {
    const filePath = path.join(tmpDir, 'write.txt');
    const interceptor = createFsInterceptor({ log });
    interceptor.install();
    try {
      fs.writeFileSync(filePath, 'data');
      const event = log.find((e) => e.detail.kind === 'fs' && e.detail.path === filePath);
      expect(event).toBeDefined();
      expect(event?.detail.kind === 'fs' && event.detail.mode).toBe('write');
    } finally {
      cleanup(interceptor);
    }
  });

  it('records appendFileSync as write', () => {
    const filePath = path.join(tmpDir, 'append.txt');
    fs.writeFileSync(filePath, 'base');

    const interceptor = createFsInterceptor({ log });
    interceptor.install();
    try {
      fs.appendFileSync(filePath, ' more');
      const event = log.find(
        (e) => e.detail.kind === 'fs' && e.detail.path === filePath && e.detail.mode === 'write'
      );
      expect(event).toBeDefined();
    } finally {
      cleanup(interceptor);
    }
  });

  it('records fs.promises.readFile as read', async () => {
    const filePath = path.join(tmpDir, 'async-read.txt');
    fs.writeFileSync(filePath, 'async-content');

    const interceptor = createFsInterceptor({ log });
    interceptor.install();
    try {
      await fs.promises.readFile(filePath, 'utf-8');
      const event = log.find((e) => e.detail.kind === 'fs' && e.detail.path === filePath);
      expect(event).toBeDefined();
      expect(event?.detail.kind === 'fs' && event.detail.mode).toBe('read');
    } finally {
      cleanup(interceptor);
    }
  });

  it('restores original fs functions on uninstall', () => {
    const origReadFileSync = fs.readFileSync;
    const interceptor = createFsInterceptor({ log });
    interceptor.install();
    expect(fs.readFileSync).not.toBe(origReadFileSync);
    interceptor.uninstall();
    expect(fs.readFileSync).toBe(origReadFileSync);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks and throws when onAccess signals a violation for a non-app package', () => {
    // We simulate a non-app attribution by overriding the onAccess handler.
    // In real usage this would be called from a node_modules frame.
    let blocked = false;
    const filePath = path.join(tmpDir, 'blocked.txt');

    const interceptor = createFsInterceptor({
      log,
      onAccess: (event) => {
        if (event.detail.kind === 'fs' && event.detail.path === filePath) {
          blocked = true;
          throw new CapWardenViolationError('pkg', `fs:${event.detail.mode}:${filePath}`);
        }
      },
    });
    interceptor.install();
    try {
      expect(() => fs.readFileSync(filePath, 'utf-8')).toThrow(CapWardenViolationError);
      expect(blocked).toBe(true);
    } finally {
      interceptor.uninstall();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails open (does NOT block) when CapWarden itself errors (NFR-4)', () => {
    const filePath = path.join(tmpDir, 'failopen.txt');
    fs.writeFileSync(filePath, 'safe');
    const interceptor = createFsInterceptor({
      log,
      onAccess: () => {
        throw new Error('simulated internal bug');
      },
    });
    interceptor.install();
    try {
      // A CapWarden bug must not deny the read — the real contents come back.
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('safe');
    } finally {
      interceptor.uninstall();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ─── GAP §1.3: destructive operations must be intercepted ──────────────────

  it('records unlinkSync as a write (GAP §1.3)', () => {
    const filePath = path.join(tmpDir, 'victim.txt');
    fs.writeFileSync(filePath, 'x'); // set up before install
    const interceptor = createFsInterceptor({ log });
    interceptor.install();
    try {
      fs.unlinkSync(filePath);
      const event = log.find(
        (e) => e.detail.kind === 'fs' && e.detail.path === filePath && e.detail.mode === 'write'
      );
      expect(event).toBeDefined();
    } finally {
      cleanup(interceptor);
    }
  });

  it('records renameSync as a write on the source path (GAP §1.3)', () => {
    const from = path.join(tmpDir, 'a.txt');
    const to = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(from, 'x'); // set up before install
    const interceptor = createFsInterceptor({ log });
    interceptor.install();
    try {
      fs.renameSync(from, to);
      const event = log.find(
        (e) => e.detail.kind === 'fs' && e.detail.path === from && e.detail.mode === 'write'
      );
      expect(event).toBeDefined();
    } finally {
      cleanup(interceptor);
    }
  });

  it('records mkdirSync as a write (GAP §1.3)', () => {
    const dirPath = path.join(tmpDir, 'newdir');
    const interceptor = createFsInterceptor({ log });
    interceptor.install();
    try {
      fs.mkdirSync(dirPath);
      const event = log.find(
        (e) => e.detail.kind === 'fs' && e.detail.path === dirPath && e.detail.mode === 'write'
      );
      expect(event).toBeDefined();
    } finally {
      cleanup(interceptor);
    }
  });

  it('records fs.promises.unlink as a write (GAP §1.3)', async () => {
    const filePath = path.join(tmpDir, 'async-victim.txt');
    fs.writeFileSync(filePath, 'x');
    const interceptor = createFsInterceptor({ log });
    interceptor.install();
    try {
      await fs.promises.unlink(filePath);
      const event = log.find(
        (e) => e.detail.kind === 'fs' && e.detail.path === filePath && e.detail.mode === 'write'
      );
      expect(event).toBeDefined();
    } finally {
      cleanup(interceptor);
    }
  });

  it('restores destructive-op originals on uninstall (GAP §1.3)', () => {
    const origUnlinkSync = fs.unlinkSync;
    const origRename = fs.rename;
    const interceptor = createFsInterceptor({ log });
    interceptor.install();
    expect(fs.unlinkSync).not.toBe(origUnlinkSync);
    interceptor.uninstall();
    expect(fs.unlinkSync).toBe(origUnlinkSync);
    expect(fs.rename).toBe(origRename);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('never records file contents — only paths (NFR-5)', async () => {
    const filePath = path.join(tmpDir, 'secret.txt');
    fs.writeFileSync(filePath, 'TOP-SECRET-CONTENTS');

    const interceptor = createFsInterceptor({ log });
    interceptor.install();
    try {
      fs.readFileSync(filePath, 'utf-8');
      const json = JSON.stringify(log);
      expect(json).not.toContain('TOP-SECRET-CONTENTS');
      expect(json).toContain(filePath);
    } finally {
      cleanup(interceptor);
    }
  });
});
