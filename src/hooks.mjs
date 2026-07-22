/**
 * CapWarden ESM loader hooks.
 *
 * Registered via module.register() (called from register.mjs) or legacy:
 *   node --loader capwarden/hooks app.mjs
 *
 * MVP behaviour
 * ─────────────
 * resolve and load hooks pass through unchanged.  Stack-based attribution
 * works for ESM packages because Node.js includes file:// URLs (which contain
 * node_modules/<pkg>) in stack frames, and extractPackageFromPath() handles
 * file:// URLs correctly by splitting on '/'.
 *
 * GA roadmap
 * ──────────
 * The load hook can source-transform ESM modules to wrap their exports in
 * packageContext.run(pkgName, fn), matching what the CJS Module._load patch
 * does.  This will be added in a future release to give full async-context
 * attribution for ESM packages across await / timer boundaries.
 */

/**
 * initialize — called once when the loader thread starts.
 * Reserved for future MessagePort-based main↔loader communication.
 */
export async function initialize(_data) {
  // no-op in MVP
}

/**
 * resolve — intercept import specifier resolution.
 * Pass through to Node's default resolver.
 *
 * @param {string} specifier
 * @param {object} context
 * @param {Function} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context);
}

/**
 * load — intercept module source loading.
 * MVP: pass through.
 * Future: wrap exports in async-context for GA attribution.
 *
 * @param {string} url
 * @param {object} context
 * @param {Function} nextLoad
 */
export async function load(url, context, nextLoad) {
  return nextLoad(url, context);
}
