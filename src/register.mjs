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
 *   `import http from 'http'` in an ESM module returns the same underlying
 *   namespace object that `require('http')` returns.  All patches applied via
 *   require() therefore affect ESM consumers too.
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
