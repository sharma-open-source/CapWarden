/**
 * Public API surface for programmatic use.
 */
export type { AccessEvent, AccessLog, CapabilityKind, CapWardenMode, AccessDetail } from './types.js';
export { loadConfig, resolvePolicyPath, resolveInventoryPath, type CapWardenConfig } from './config.js';
export * from './policy/index.js';
export * from './report/index.js';
export * from './modes/index.js';
export * from './interceptors/index.js';
export * from './attribution/index.js';
export * from './install-scripts/index.js';
