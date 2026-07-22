import { describe, it, expect } from 'vitest';
import {
  extractPackageFromPath,
  attributeFromStack,
  classifyReaderContext,
} from '../../src/attribution/stack';

describe('attribution/stack — classifyReaderContext (GAP §1.4)', () => {
  it('classifies a direct user-code reader as external', () => {
    expect(classifyReaderContext()).toBe('external');
  });

  it('classifies a reader nested under user code as external', () => {
    // A user wrapper frame is always the immediate caller here, so suppression
    // never triggers for reads that user/dependency code performs — only reads
    // Node performs *directly* (a node: immediate caller) are treated as
    // internal. That direct-node: path is exercised end-to-end by the env
    // interceptor's Node-internal-key suppression tests.
    const nested = () => classifyReaderContext();
    expect(nested()).toBe('external');
  });
});

describe('attribution/stack — extractPackageFromPath', () => {
  it('extracts a plain package name from a node_modules path', () => {
    expect(extractPackageFromPath('/project/node_modules/lodash/lib/index.js')).toBe('lodash');
  });

  it('extracts a scoped package name', () => {
    expect(extractPackageFromPath('/project/node_modules/@sentry/node/dist/index.js')).toBe('@sentry/node');
  });

  it('returns null for a non-node_modules path (first-party)', () => {
    expect(extractPackageFromPath('/project/src/app.ts')).toBeNull();
  });

  it('handles nested node_modules — returns the INNERMOST (most specific) package', () => {
    // File belongs to debug (nested inside mocha's node_modules), not mocha
    const p = extractPackageFromPath(
      '/project/node_modules/mocha/node_modules/debug/src/index.js'
    );
    expect(p).toBe('debug');
  });

  it('returns null for empty path', () => {
    expect(extractPackageFromPath('')).toBeNull();
  });

  it('handles Windows-style backslash paths for scoped packages', () => {
    expect(
      extractPackageFromPath('C:\\project\\node_modules\\@scope\\pkg\\index.js')
    ).toBe('@scope/pkg');
  });

  it('returns null for a bare node_modules path with no package segment', () => {
    expect(extractPackageFromPath('/project/node_modules/')).toBeNull();
  });
});

describe('attribution/stack — attributeFromStack', () => {
  it('returns a string (app or a package name)', () => {
    // Running inside test code — should return 'app' or a vitest package name
    const result = attributeFromStack();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
