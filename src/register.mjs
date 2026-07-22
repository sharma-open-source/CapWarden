/**
 * CapWarden ESM entry point.
 *
 * Loaded via:  node --import capwarden/register app.mjs
 *
 * Activates the CJS interceptors — which patch the shared built-in module
 * objects (http, https, net, fs, child_process) used by both CJS and ESM —
 * then registers the ESM loader hooks for future async-context attribution.
 *
 * Why CJS interceptors work for ESM:
 *   A default import (`import http from 'http'`) is the same mutable object
 *   that `require('http')` returns, so patches are always visible through it.
 *   Named imports (`import { readFile } from 'node:fs/promises'`) are
 *   SNAPSHOTS taken when Node first evaluates the builtin's ESM facade.
 *   Because this file runs as a preload — before any app module is evaluated —
 *   the snapshots capture the already-patched functions.  This only holds if
 *   capwarden/register is the FIRST preload; the self-check below detects the
 *   case where an earlier preload evaluated a builtin facade before us.
 *
 * Requires Node >= 20.6.0 (--import flag + module.register API).
 */

import { createRequire } from 'node:module';
import { register } from 'node:module';

const require = createRequire(import.meta.url);

// Activate CJS interceptors + Module._load patch (env, net, fs, proc)
require('./register.js');

// Register ESM loader hooks for async-context attribution of ESM packages.
// If module.register is unavailable (Node < 20.6) the catch is a no-op;
// stack-based attribution (MVP) remains active as fallback.
try {
  register(new URL('./hooks.mjs', import.meta.url));
} catch {
  // Intentional no-op — stack attribution still works
}

// Self-check: named ESM bindings of builtins are snapshots taken when the
// builtin's module facade is first evaluated — first evaluation wins,
// process-wide. If another preload evaluated a builtin before our patches
// landed, every named import of it in the app silently bypasses interception.
// Detect that by comparing the ESM namespace value against the (patched) CJS
// export. When CAPWARDEN is off nothing is patched, so this stays silent.
// Importing the sentinels here also forces facade evaluation now, locking in
// the patched snapshots as early as possible.
const SENTINELS = [
  ['node:fs', 'readFileSync'],
  ['node:fs/promises', 'readFile'],
  ['node:http', 'request'],
  ['node:child_process', 'spawn'],
];
let bindingWarningShown = false;
for (const [specifier, name] of SENTINELS) {
  import(specifier).then((ns) => {
    if (!bindingWarningShown && ns[name] !== require(specifier)[name]) {
      bindingWarningShown = true;
      console.error(
        `[CapWarden] WARNING: the ESM binding for ${specifier}.${name} was created ` +
        `before CapWarden's interceptors were installed — an earlier --import/--require ` +
        `preload likely evaluated ${specifier} first. Named ESM imports of patched ` +
        `builtins will BYPASS CapWarden in this process. ` +
        `Make capwarden/register the first preload flag.`,
      );
    }
  }).catch(() => { /* sentinel unavailable on this Node version — ignore */ });
}
