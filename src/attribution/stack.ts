/**
 * MVP attribution: walk the V8 call stack to find the nearest
 * `node_modules/<pkg>` frame and return the package name.
 *
 * Returns 'app' for frames with no node_modules ancestor —
 * first-party code is always allowed (FR-12).
 *
 * Handles scoped packages (@scope/name) correctly (FR-13).
 *
 * Known limitation: if a compromised package routes a call through a
 * legitimate library, the innocent library may be blamed.  This is
 * mitigated at GA by AsyncLocalStorage attribution (see async-context.ts).
 */

import { currentPackageFromContext } from './async-context.js';
import { isFirstPartyPackage } from './workspaces.js';

/**
 * Extract the innermost (most-specific) package name from an absolute file
 * path by finding the LAST `node_modules` segment in the path.
 *
 * For nested installs like `.../mocha/node_modules/debug/index.js` the file
 * belongs to `debug`, not `mocha`, so we must use the last occurrence.
 *
 * Returns null if the path contains no node_modules segment (first-party).
 */
export function extractPackageFromPath(filePath: string): string | null {
  // Find all node_modules occurrences and use the last one (innermost package)
  const segments = filePath.split(/[/\\]/);
  let lastNmIndex = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] === 'node_modules') {
      lastNmIndex = i;
      break;
    }
  }

  if (lastNmIndex === -1) return null;

  const after = segments.slice(lastNmIndex + 1);
  if (after.length === 0) return null;

  // Handle scoped packages: @scope/name
  if (after[0].startsWith('@') && after.length >= 2) {
    return `${after[0]}/${after[1]}`;
  }

  return after[0] || null;
}

/**
 * Attribute the current call to a package name.
 *
 * Strategy (in priority order):
 *   1. AsyncLocalStorage context — set by the Module._load patch when control
 *      enters a package's functions. Survives async boundaries (FR-11 GA).
 *   2. V8 call-stack walk — nearest node_modules frame. MVP fallback.
 *
 * Returns 'app' when no package attribution is found (first-party code).
 */
export function attributeCurrentCall(): string {
  // 1. Prefer async context (GA path — survives callbacks/promises/timers)
  const fromContext = currentPackageFromContext();
  // 2. Fall back to stack walk (MVP path)
  const name = fromContext ?? attributeFromStack();

  // Local workspace packages are first-party code — fold them into 'app' so a
  // monorepo doesn't flag its own sibling packages as dependencies (Open Q3).
  return isFirstPartyPackage(name) ? 'app' : name;
}

/**
 * Matches CapWarden's own interceptor / attribution source frames so they can
 * be skipped when we need to inspect the code that *triggered* an intercepted
 * access.  Covers both the compiled `dist/` (.js) and test-time `src/` (.ts).
 */
const CW_OWN_FRAME =
  /[/\\](?:interceptors|attribution)[/\\][\w.-]+\.[cm]?[jt]s$/;

/**
 * Classify the code that triggered the current intercepted access — i.e. the
 * first stack frame above CapWarden's own trap frames.
 *
 *   'internal' → the immediate reader is Node itself (a `node:` internal module
 *                or a native frame).  Used to avoid charging a package for env
 *                reads that Node performs while merely executing inside the
 *                package's async context (GAP §1.4 — the R1 alert-fatigue bug).
 *   'external' → the immediate reader is user / dependency JavaScript.
 *
 * We verified (proxy get-trap probe) that V8 inserts no native frame between a
 * Proxy trap and its caller, so the first non-CapWarden frame is the true
 * reader.
 */
export function classifyReaderContext(): 'internal' | 'external' {
  const savedPrepare = Error.prepareStackTrace;
  const savedLimit = Error.stackTraceLimit;
  try {
    // Node's default limit of 10 can truncate the stack before the relevant
    // frame; capture more so classification does not silently fall through.
    Error.stackTraceLimit = STACK_TRACE_LIMIT;
    let frames: NodeJS.CallSite[] = [];
    Error.prepareStackTrace = (_err, callsites) => {
      frames = callsites;
      return '';
    };
    const err = new Error();
    void err.stack;

    for (const frame of frames) {
      const file = frame.getFileName();
      if (file && CW_OWN_FRAME.test(file)) continue; // our own trap frames
      if (file === null) {
        // Native C++ frame (e.g. bindings reading env) counts as internal;
        // an anonymous non-native frame is skipped.
        if (frame.isNative()) return 'internal';
        continue;
      }
      if (file.startsWith('node:') || file.startsWith('internal/')) {
        return 'internal';
      }
      return 'external';
    }
    return 'external';
  } finally {
    Error.prepareStackTrace = savedPrepare;
    Error.stackTraceLimit = savedLimit;
  }
}

/**
 * How many stack frames to capture during attribution. Node's default of 10 is
 * too shallow: when a package's `node_modules` frame sits below several
 * intervening app/library frames, a 10-frame capture returns 'app' — attribution
 * fails *toward allow*, silently. 32 comfortably covers realistic call depths
 * (attribution returns at the first node_modules frame, so the full walk is the
 * rare no-package case) while keeping the per-call capture cheap.
 */
const STACK_TRACE_LIMIT = 32;

/**
 * Walk the V8 call stack and return the package owning the nearest
 * node_modules frame.  Returns 'app' if no such frame is found.
 */
export function attributeFromStack(): string {
  const savedPrepare = Error.prepareStackTrace;
  const savedLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = STACK_TRACE_LIMIT;
    let frames: NodeJS.CallSite[] = [];
    Error.prepareStackTrace = (_err, callsites) => {
      frames = callsites;
      return '';
    };
    const err = new Error();
    void err.stack;

    for (const frame of frames) {
      const file = frame.getFileName();
      if (!file) continue;
      const pkg = extractPackageFromPath(file);
      if (pkg) return pkg;
    }
    return 'app';
  } finally {
    Error.prepareStackTrace = savedPrepare;
    Error.stackTraceLimit = savedLimit;
  }
}
