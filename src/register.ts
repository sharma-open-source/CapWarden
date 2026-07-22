/**
 * capwarden/register — preload entry point.
 *
 * Loaded via:  node --require capwarden/register app.js
 * Or via:      NODE_OPTIONS=--require=capwarden/register
 *
 * Reads the CAPWARDEN env var (or --capwarden-mode flag) to select mode,
 * then activates the appropriate interceptors (FR-1, FR-7).
 */

import * as fs from 'fs';
import type { CapWardenMode } from './types.js';
import { loadConfig, resolvePolicyPath } from './config.js';
import { startObserveMode } from './modes/observe.js';
import { startEnforceMode } from './modes/enforce.js';
import { startUpdateMode } from './modes/update.js';
import { parsePolicy } from './policy/load.js';
import { discoverWorkspacePackages, setFirstPartyPackages } from './attribution/workspaces.js';

function resolveMode(): CapWardenMode {
  const envMode = process.env['CAPWARDEN']?.toLowerCase();
  if (
    envMode === 'observe' ||
    envMode === 'enforce' ||
    envMode === 'update' ||
    envMode === 'off'
  ) {
    return envMode;
  }
  // Default to off when loaded without explicit mode (safe)
  return 'off';
}

function activate(): void {
  const mode = resolveMode();
  if (mode === 'off') return;

  const config = loadConfig();
  const policyPath = resolvePolicyPath(config);

  // Fold local workspace packages into 'app' so a monorepo doesn't flag its own
  // sibling packages as third-party dependencies (Open Q3). Config `ignored`
  // stays available for anything discovery misses.
  setFirstPartyPackages(discoverWorkspacePackages(process.cwd()));

  if (mode === 'observe') {
    startObserveMode({
      outputDir: process.env['CAPWARDEN_OUTPUT_DIR'],
      schema: process.env['CAPWARDEN_SCHEMA'] === 'v2' ? 'v2' : 'v1',
      strict: process.env['CAPWARDEN_STRICT'] === '1',
    });
    return;
  }

  if (mode === 'update') {
    startUpdateMode({
      policyPath,
      write: process.env['CAPWARDEN_WRITE'] === '1',
      failOnAdditions: process.env['CAPWARDEN_FAIL_ON_ADDITIONS'] === '1',
    });
    return;
  }

  // enforce
  let policy;
  try {
    policy = parsePolicy(fs.readFileSync(policyPath, 'utf-8'));
  } catch {
    console.error(
      `[CapWarden] enforce mode: could not read policy at ${policyPath}.\n` +
      `  Run 'capwarden observe' first to generate the baseline policy.\n`
    );
    process.exit(1);
  }
  const onViolation = process.env['CAPWARDEN_FAIL_OPEN'] === '1'
    ? 'log'
    : (config.onViolation ?? 'block');
  startEnforceMode({
    policy,
    onViolation,
    onInternalError: config.onInternalError,
    ignored: config.ignored,
    denied: config.denied,
  });
}

activate();
