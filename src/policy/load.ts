/**
 * Version-detecting policy loader. A committed `capwarden-policy.json` may be
 * either v1 (kind-level) or v2 (strict sub-detail); enforce mode accepts both.
 */

import { parseV1, type PolicyV1 } from './schema-v1.js';
import { parseV2, type PolicyV2 } from './schema-v2.js';

export function parsePolicy(json: string): PolicyV1 | PolicyV2 {
  const raw = JSON.parse(json) as { version?: unknown };
  if (raw && typeof raw === 'object' && raw.version === 2) return parseV2(json);
  return parseV1(json);
}
