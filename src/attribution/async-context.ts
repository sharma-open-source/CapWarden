/**
 * GA attribution: AsyncLocalStorage-based ownership tracking (FR-11).
 *
 * How it works
 * ────────────
 * 1. `installModuleLoadPatch()` monkey-patches `Module._load` (the CJS require
 *    machinery) so that when a node_modules package is first loaded, all of its
 *    exported functions are wrapped.  Each wrapped export runs inside
 *    `packageContext.run(pkgName, fn)` so that any intercepted primitive called
 *    — synchronously or via callback/promise/timer — finds the package name in
 *    async context rather than on the call stack.
 *
 * 2. `currentPackageFromContext()` returns the package name stored in async
 *    context, or null if not set.  Interceptors call this first; if null they
 *    fall back to stack attribution.
 *
 * 3. `runAsPackage()` is the low-level primitive used both by the Module._load
 *    patch and by any manual override.
 *
 * Why this is better than stack-walking
 * ──────────────────────────────────────
 * Stack walking can miss attribution when:
 *   - A package schedules work via setTimeout/setImmediate and the callback
 *     fires without a package frame on the stack.
 *   - A package passes a callback to a legitimate library; when that callback
 *     calls http.request, the stack shows the legitimate library not the
 *     originating package.
 * AsyncLocalStorage propagates the context across all these async transitions.
 *
 * Documented gap: native addons that perform I/O below the JS boundary are not
 * interceptable and therefore not attributable.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { extractPackageFromPath } from './stack.js';

const packageContext = new AsyncLocalStorage<string>();

/**
 * Run `fn` with the given package name as the current owner in async context.
 * All intercepted accesses within `fn` (including async continuations) will be
 * attributed to `packageName`.
 */
export function runAsPackage<T>(packageName: string, fn: () => T): T {
  return packageContext.run(packageName, fn);
}

/**
 * Return the package name from async context, or null if not set.
 * Interceptors call this before falling back to stack attribution.
 */
export function currentPackageFromContext(): string | null {
  return packageContext.getStore() ?? null;
}

// ─── Module._load patch ───────────────────────────────────────────────────────

let _patchInstalled = false;
let _originalLoad: ((request: string, parent: unknown, isMain: boolean) => unknown) | null = null;

/**
 * Patch `Module._load` so that when a node_modules package is required, its
 * exported functions are wrapped to run inside the package's async context.
 *
 * This is idempotent — safe to call multiple times.
 *
 * Call this once during CapWarden startup (observe / enforce mode activation).
 */
export function installModuleLoadPatch(): void {
  if (_patchInstalled) return;
  _patchInstalled = true;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require('module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };

  _originalLoad = Module._load;
  let _inPatch = false; // re-entrancy guard

  Module._load = function capwardenLoad(
    request: string,
    parent: unknown,
    isMain: boolean
  ): unknown {
    const exports = _originalLoad!.call(this, request, parent, isMain);

    // Guard against re-entrancy (e.g. _resolveFilename calling _load internally)
    if (_inPatch) return exports;

    // Only wrap node_modules packages (not built-ins or first-party)
    _inPatch = true;
    let pkgName: string | null = null;
    try {
      pkgName = resolvePackageNameFromRequest(request, parent);
    } finally {
      _inPatch = false;
    }

    if (!pkgName) return exports;
    return wrapExports(exports, pkgName);
  };
}

/**
 * Cache of already-wrapped exports, keyed by the original exports object.
 *
 * `Module._load` returns Node's cached exports for repeated `require()`s of the
 * same module, so without this every require would re-wrap and yield a *new*
 * object — breaking `require('x') === require('x')` and singleton/state
 * patterns, and re-doing the wrap work each time. Keying on the original
 * exports makes the wrapped result stable and cheap on repeat.
 */
const wrappedCache = new WeakMap<object, unknown>();

/** Remove the Module._load patch (for testing and graceful shutdown). */
export function uninstallModuleLoadPatch(): void {
  if (!_patchInstalled) return;
  _patchInstalled = false;

  if (_originalLoad) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Module = require('module') as {
      _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    };
    Module._load = _originalLoad;
    _originalLoad = null;
  }
}

/**
 * Attempt to resolve a require request to a node_modules package name.
 * Returns null for built-ins and relative/absolute first-party paths.
 */
function resolvePackageNameFromRequest(request: string, parent: unknown): string | null {
  // Built-ins and relative/absolute paths → first-party
  if (request.startsWith('.') || request.startsWith('/')) return null;

  // Try to resolve the file path and extract the package name
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Module = require('module') as {
      _resolveFilename: (request: string, parent: unknown) => string;
    };
    const resolved = Module._resolveFilename(request, parent);
    return extractPackageFromPath(resolved);
  } catch {
    // Built-in modules (fs, http, etc.) throw on _resolveFilename
    return null;
  }
}

/**
 * Wrap exported functions of a module so they run inside async context for
 * the given package name.
 *
 * Only wraps plain functions and methods on plain objects (not class instances,
 * Buffers, or other special objects) to avoid compatibility issues.
 */
function wrapExports(exports: unknown, pkgName: string): unknown {
  if (exports === null || (typeof exports !== 'object' && typeof exports !== 'function')) {
    return exports;
  }

  // Return the same wrapped object for repeated requires (identity + speed).
  const cached = wrappedCache.get(exports as object);
  if (cached !== undefined) return cached;

  let wrapped: unknown;

  if (typeof exports === 'function') {
    wrapped = wrapFn(exports as (...args: unknown[]) => unknown, pkgName);
  } else {
    // Avoid wrapping special objects (Buffer, EventEmitter instances, etc.)
    const proto = Object.getPrototypeOf(exports);
    if (proto !== null && proto !== Object.prototype) {
      wrappedCache.set(exports as object, exports);
      return exports;
    }

    // Shallow-wrap own enumerable function properties
    const obj: Record<string, unknown> = Object.create(proto);
    for (const [key, value] of Object.entries(exports as Record<string, unknown>)) {
      obj[key] = typeof value === 'function'
        ? wrapFn(value as (...args: unknown[]) => unknown, pkgName)
        : value;
    }
    wrapped = obj;
  }

  wrappedCache.set(exports as object, wrapped);
  return wrapped;
}

/** Wrap a single function to run inside the package's async context. */
function wrapFn(fn: (...args: unknown[]) => unknown, pkgName: string): (...args: unknown[]) => unknown {
  const isClass = isClassConstructor(fn);

  let wrapper: (...args: unknown[]) => unknown;

  if (isClass) {
    // Classes must be called with `new`; use Reflect.construct to preserve `this`
    wrapper = function (this: unknown, ...args: unknown[]): unknown {
      return packageContext.run(pkgName, () => Reflect.construct(fn, args, new.target ?? fn));
    };
  } else {
    wrapper = function (this: unknown, ...args: unknown[]): unknown {
      return packageContext.run(pkgName, () => fn.apply(this, args));
    };
  }

  // Preserve name and length for diagnostics
  Object.defineProperty(wrapper, 'name', { value: fn.name, configurable: true });
  Object.defineProperty(wrapper, 'length', { value: fn.length, configurable: true });
  // Preserve prototype so instanceof checks still work
  if (fn.prototype !== undefined) {
    wrapper.prototype = fn.prototype;
  }

  // Copy the function's own static properties onto the wrapper. Many CJS
  // packages export a function that carries statics (e.g. `express.Router`,
  // `express.static`, `chalk.red`); dropping them would break those consumers.
  // We copy the value as-is rather than re-wrapping — restoring behavior is the
  // goal, and a static callable is still attributable via its own require
  // context and the stack-walk fallback.
  for (const key of Reflect.ownKeys(fn)) {
    if (key === 'name' || key === 'length' || key === 'prototype') continue;
    const desc = Object.getOwnPropertyDescriptor(fn, key);
    if (desc) Object.defineProperty(wrapper, key, desc);
  }
  return wrapper;
}

/**
 * Determine whether a function is an ES6 class constructor.
 * Class constructors must be invoked with `new`; regular functions may not.
 */
function isClassConstructor(fn: (...args: unknown[]) => unknown): boolean {
  const str = Function.prototype.toString.call(fn);
  return /^\s*class[\s{]/.test(str);
}
