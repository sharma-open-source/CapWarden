#!/usr/bin/env node
/**
 * CapWarden CLI — capwarden observe | enforce | update | report
 *
 * Mode is also selectable via CAPWARDEN env var (FR-2, FR-7).
 */

import { Command } from 'commander';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, resolvePolicyPath, resolveInventoryPath } from '../config.js';
import { startObserveMode } from '../modes/observe.js';
import { startEnforceMode } from '../modes/enforce.js';
import { startUpdateMode } from '../modes/update.js';
import { parsePolicy } from '../policy/load.js';
import { parseV1 } from '../policy/schema-v1.js';
import { migrateV1ToV2, serializeV2 } from '../policy/schema-v2.js';
import { renderTerminalReportFromJson } from '../report/terminal.js';
import type { JsonReport } from '../report/json.js';
import { buildInstallInventory, diffInventory, type InstallInventory } from '../install-scripts/inventory.js';
import { runInstallScripts } from '../install-scripts/runner.js';
import { buildCoverageReport } from '../report/coverage.js';

const program = new Command();

/** Read the CLI version from the installed package.json (avoids drift). */
function resolveVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Run `command` in a child process with CapWarden preloaded (FR-2).
 *
 * The child is launched with `--require <dist/register.js>` injected into
 * NODE_OPTIONS and `CAPWARDEN=<mode>` set, so the interceptors are active before
 * any dependency code runs — including in nested Node processes spawned by the
 * command (e.g. `npm test` → vitest). Returns the child's exit code so the CI
 * gate propagates (FR-17).
 */
function runUnderMode(
  mode: 'observe' | 'enforce' | 'update',
  command: string[],
  extraEnv: Record<string, string>
): number {
  const register = path.resolve(__dirname, '..', 'register.js');
  const priorNodeOptions = process.env['NODE_OPTIONS'] ?? '';
  const nodeOptions = `${priorNodeOptions} --require ${register}`.trim();

  const [cmd, ...args] = command;
  const child = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv, CAPWARDEN: mode, NODE_OPTIONS: nodeOptions },
  });

  if (child.error) {
    const err = child.error as NodeJS.ErrnoException;
    const hint = err.code === 'ENOENT' ? ` (command not found: ${cmd})` : '';
    console.error(`[CapWarden] Failed to run '${command.join(' ')}'${hint}: ${err.message}`);
    return 1;
  }
  if (child.signal) {
    console.error(`[CapWarden] '${command.join(' ')}' terminated by signal ${child.signal}`);
    return 1;
  }
  return child.status ?? 0;
}

program
  .name('capwarden')
  .description('Per-dependency capability guard for Node.js / npm')
  .version(resolveVersion());

// ─── observe ─────────────────────────────────────────────────────────────────
program
  .command('observe')
  .argument('[command...]', 'Command to run under observation (after `--`)')
  .description('Record all dependency capability accesses. Blocks nothing.')
  .option('-o, --output <dir>', 'Output directory for report + policy', process.cwd())
  .option('--schema <version>', 'Policy schema to emit: v1 or v2', 'v1')
  .option('--strict', 'v2 only: pin exact sub-detail tokens (host, path, key)', false)
  .action((command: string[], opts: { output: string; schema: string; strict: boolean }) => {
    const schema = opts.schema === 'v2' ? 'v2' : 'v1';
    if (command.length > 0) {
      const env: Record<string, string> = { CAPWARDEN_OUTPUT_DIR: opts.output };
      if (schema === 'v2') env['CAPWARDEN_SCHEMA'] = 'v2';
      if (opts.strict) env['CAPWARDEN_STRICT'] = '1';
      process.exit(runUnderMode('observe', command, env));
    }
    process.env['CAPWARDEN'] = 'observe';
    startObserveMode({ outputDir: opts.output, schema, strict: opts.strict });
    console.error('[CapWarden] Running in observe mode. Start your app or test suite.');
    console.error('  (Tip: `capwarden observe -- <your command>` runs it for you.)');
  });

// ─── enforce ─────────────────────────────────────────────────────────────────
program
  .command('enforce')
  .argument('[command...]', 'Command to run under enforcement (after `--`)')
  .description('Load committed policy and block any deviation. Exits non-zero on violation.')
  .option('--fail-open', 'Log violations but do not block (fail-open for production)', false)
  .action((command: string[], opts: { failOpen: boolean }) => {
    if (command.length > 0) {
      process.exit(
        runUnderMode('enforce', command, opts.failOpen ? { CAPWARDEN_FAIL_OPEN: '1' } : {})
      );
    }

    const config = loadConfig();
    const policyPath = resolvePolicyPath(config);

    let policy;
    try {
      policy = parsePolicy(fs.readFileSync(policyPath, 'utf-8'));
    } catch {
      console.error(`[CapWarden] Could not read policy at ${policyPath}`);
      console.error(`  Run 'capwarden observe' first.`);
      process.exit(1);
    }

    const onViolation = opts.failOpen ? 'log' : (config.onViolation ?? 'block');
    process.env['CAPWARDEN'] = 'enforce';
    startEnforceMode({
      policy,
      onViolation,
      onInternalError: config.onInternalError,
      ignored: config.ignored,
      denied: config.denied,
    });
    console.error('[CapWarden] Running in enforce mode.');
    console.error('  (Tip: `capwarden enforce -- <your command>` runs it for you.)');
  });

// ─── update ──────────────────────────────────────────────────────────────────
program
  .command('update')
  .argument('[command...]', 'Command to re-observe under (after `--`)')
  .description('Re-observe and diff against committed policy. Does not auto-commit.')
  .option('--fail-on-additions', 'Exit non-zero if new capabilities are detected', false)
  .option('--write', 'Write the regenerated policy after showing the diff (FR-6)', false)
  .action((command: string[], opts: { failOnAdditions: boolean; write: boolean }) => {
    const config = loadConfig();
    const policyPath = resolvePolicyPath(config);

    if (command.length > 0) {
      const env: Record<string, string> = {};
      if (opts.write) env['CAPWARDEN_WRITE'] = '1';
      if (opts.failOnAdditions) env['CAPWARDEN_FAIL_ON_ADDITIONS'] = '1';
      process.exit(runUnderMode('update', command, env));
    }

    startUpdateMode({ policyPath, failOnAdditions: opts.failOnAdditions, write: opts.write });
    console.error('[CapWarden] Running update mode. Start your app or test suite.');
    console.error('  (Tip: `capwarden update -- <your command>` runs it for you.)');
  });

// ─── report ──────────────────────────────────────────────────────────────────
program
  .command('report')
  .description('Print the last observe report in human-readable form.')
  .option('--json', 'Print raw JSON report', false)
  .option('--report-file <file>', 'Path to report JSON', 'capwarden-report.json')
  .action((opts: { json: boolean; reportFile: string }) => {
    const reportPath = path.resolve(process.cwd(), opts.reportFile);
    if (!fs.existsSync(reportPath)) {
      console.error(`[CapWarden] No report found at ${reportPath}`);
      console.error(`  Run 'capwarden observe' first.`);
      process.exit(1);
    }

    const raw = fs.readFileSync(reportPath, 'utf-8');

    if (opts.json) {
      console.log(raw);
      return;
    }

    // Render the full human-readable terminal view from the saved report (FR-16).
    const report = JSON.parse(raw) as JsonReport;
    console.error(`[CapWarden] Report from ${reportPath}`);
    renderTerminalReportFromJson(report);
  });

// ─── inventory ───────────────────────────────────────────────────────────────
program
  .command('inventory')
  .description('Report packages with lifecycle install scripts.')
  .option('--diff', 'Diff against committed inventory', false)
  .option('--write', 'Write the built inventory to the committed baseline', false)
  .action((opts: { diff: boolean; write: boolean }) => {
    const config = loadConfig();
    const inventoryPath = resolveInventoryPath(config);
    const nodeModulesDir = path.join(process.cwd(), 'node_modules');
    const newInventory = buildInstallInventory(nodeModulesDir);

    if (opts.diff) {
      if (fs.existsSync(inventoryPath)) {
        const oldInventory = JSON.parse(
          fs.readFileSync(inventoryPath, 'utf-8')
        ) as InstallInventory;
        const added = diffInventory(oldInventory, newInventory);

        if (added.length === 0) {
          console.log('[CapWarden] No new install scripts detected.');
        } else {
          console.warn(`[CapWarden] ⚠ New install scripts detected (review required):`);
          for (const entry of added) {
            console.warn(`  + ${entry.packageName}@${entry.version}: ${entry.scripts.join(', ')}`);
          }
          process.exitCode = 1;
        }
      } else if (!opts.write) {
        console.error(`[CapWarden] No committed inventory at ${inventoryPath} to diff against.`);
        console.error(`  Run 'capwarden inventory --write' to create the baseline.`);
        process.exitCode = 1;
      }
    } else if (!opts.write) {
      console.log(JSON.stringify(newInventory, null, 2));
    }

    // Never write as a side effect of --diff (that silently defeats FR-15).
    // The committed baseline changes only when the user explicitly asks.
    if (opts.write) {
      fs.writeFileSync(inventoryPath, JSON.stringify(newInventory, null, 2), 'utf-8');
      console.error(`[CapWarden] Inventory written → ${inventoryPath}`);
    }
  });

// ─── coverage ────────────────────────────────────────────────────────────────
program
  .command('coverage')
  .description('Report packages CapWarden cannot fully instrument (R5).')
  .option('--json', 'Print raw JSON', false)
  .action((opts: { json: boolean }) => {
    const nodeModulesDir = path.join(process.cwd(), 'node_modules');
    const report = buildCoverageReport(nodeModulesDir);

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (report.partial.length === 0) {
      console.error('[CapWarden] Full instrumentation coverage — no native addons or ESM-only packages found.');
      return;
    }
    console.error('[CapWarden] ⚠ Reduced instrumentation coverage for:');
    for (const e of report.partial) {
      console.error(`  • ${e.packageName}@${e.version} — ${e.limitations.join(', ')}`);
    }
    console.error(
      '\n  native-addon: may perform syscalls below the JS layer CapWarden cannot see.\n' +
        '  esm-only    : attributed by stack-walk only (no require()-based async context).\n'
    );
  });

// ─── scripts ─────────────────────────────────────────────────────────────────
program
  .command('scripts')
  .description('Govern package lifecycle (install) scripts against the policy (FR-8, FR-14).')
  .option('--enforce', 'Fail if any package runs a lifecycle script without an `install` grant', false)
  .option('--run', 'Execute the granted scripts under CapWarden preload', false)
  .option('--mode <mode>', 'Mode for executed scripts: observe or enforce', 'observe')
  .action((opts: { enforce: boolean; run: boolean; mode: string }) => {
    const config = loadConfig();
    const nodeModulesDir = path.join(process.cwd(), 'node_modules');
    const inventory = buildInstallInventory(nodeModulesDir);

    if (inventory.packages.length === 0) {
      console.log('[CapWarden] No packages declare lifecycle install scripts.');
      return;
    }

    let policy: ReturnType<typeof parsePolicy> | undefined;
    if (opts.enforce) {
      const policyPath = resolvePolicyPath(config);
      if (!fs.existsSync(policyPath)) {
        console.error(`[CapWarden] enforce: no policy at ${policyPath}. Run 'capwarden observe' first.`);
        process.exit(1);
      }
      policy = parsePolicy(fs.readFileSync(policyPath, 'utf-8'));
    }

    const { results, blocked, exitCode } = runInstallScripts({
      inventory,
      policy,
      cwd: process.cwd(),
      execute: opts.run,
      mode: opts.mode === 'enforce' ? 'enforce' : 'observe',
      registerPath: path.resolve(__dirname, '..', 'register.js'),
    });

    if (!opts.enforce) {
      // Listing only — informational, never a gate.
      console.error('[CapWarden] Lifecycle scripts discovered:');
      for (const r of results) console.error(`  • ${r.packageName}: ${r.script}`);
      process.exit(opts.run ? exitCode : 0);
    }

    if (blocked.length > 0) {
      console.error('\n⛔  CAPWARDEN BLOCKED install scripts (no `install` grant):');
      for (const r of blocked) console.error(`     ${r.packageName}: ${r.script}`);
      console.error(`\n  Review, then grant 'install' in the policy to allow.\n`);
    } else {
      console.error('[CapWarden] All lifecycle scripts are permitted by the policy.');
    }

    process.exit(exitCode);
  });

// ─── migrate ─────────────────────────────────────────────────────────────────
program
  .command('migrate')
  .description('Migrate a committed v1 policy to the v2 schema (behavior-preserving).')
  .option('--out <file>', 'Write the v2 policy here instead of overwriting in place')
  .action((opts: { out?: string }) => {
    const config = loadConfig();
    const policyPath = resolvePolicyPath(config);
    if (!fs.existsSync(policyPath)) {
      console.error(`[CapWarden] No policy at ${policyPath} to migrate.`);
      process.exit(1);
    }
    const raw = fs.readFileSync(policyPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (parsed.version === 2) {
      console.error(`[CapWarden] ${policyPath} is already a v2 policy — nothing to do.`);
      return;
    }
    const v1 = parseV1(raw);
    const v2 = migrateV1ToV2(v1);
    const outPath = opts.out ? path.resolve(process.cwd(), opts.out) : policyPath;
    fs.writeFileSync(outPath, serializeV2(v2), 'utf-8');
    console.error(`[CapWarden] Migrated v1 → v2 policy → ${outPath}`);
    console.error(`  Every grant is a wildcard and lax; tighten with 'strict' + tokens as you review.`);
  });

program.parse(process.argv);
