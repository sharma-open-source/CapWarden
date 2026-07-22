/**
 * Canonical sub-detail token for a single access, used by the v2 (strict)
 * policy schema and its matcher.
 *
 * The token is the *value* portion only — it carries no `kind:` prefix, because
 * v2 grants are already grouped by capability kind (`grants.net`, `grants.fs`).
 * It is the unit of strict pinning: `net` → `evil.example.com:443`,
 * `fs` → `write:/etc/passwd`, `env` → `API_KEY`.
 *
 * Records metadata only — never env values or file contents (NFR-5).
 */

import type { AccessDetail } from '../types.js';

export function subDetailToken(detail: AccessDetail): string {
  switch (detail.kind) {
    case 'env':
      return detail.key;
    case 'net':
      return `${detail.host}:${detail.port}`;
    case 'fs':
      return `${detail.mode}:${detail.path}`;
    case 'proc':
      return detail.command;
    case 'install':
      return detail.script;
  }
}

/** Split a v2 package key (`name`, `name@1.2.3`, `@scope/pkg@1.2.3`) into parts. */
export function parsePackageKey(key: string): { name: string; version?: string } {
  const at = key.lastIndexOf('@');
  // A leading '@' (scoped package) is not a version separator.
  if (at <= 0) return { name: key };
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}
