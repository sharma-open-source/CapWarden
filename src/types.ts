/**
 * Core types shared across all CapWarden modules.
 */

/** The five capability kinds CapWarden tracks. */
export type CapabilityKind = 'env' | 'net' | 'fs' | 'proc' | 'install';

/** Sub-detail recorded per access, varying by kind. */
export type AccessDetail =
  | { kind: 'env'; key: string }
  | { kind: 'net'; host: string; port: number }
  | { kind: 'fs'; path: string; mode: 'read' | 'write' }
  | { kind: 'proc'; command: string }
  | { kind: 'install'; script: string; packageName: string };

/** A single intercepted privileged access. */
export interface AccessEvent {
  /** Resolved package name, or 'app' for first-party code. */
  packageName: string;
  detail: AccessDetail;
  timestamp: number;
}

/** In-memory log of all intercepted accesses during an observe/enforce run. */
export type AccessLog = AccessEvent[];

/** CapWarden operating mode. */
export type CapWardenMode = 'observe' | 'enforce' | 'update' | 'off';
