/**
 * Human-readable terminal report (FR-16, FR-17, FR-18).
 *
 * Renders the observe access log as a grouped, readable summary and
 * renders policy diffs with additions clearly separated from removals.
 */

import type { AccessLog } from '../types.js';
import type { PolicyDiff } from '../policy/diff.js';
import { renderJsonReport, type JsonReport } from './json.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

/** Print the full observe report to stderr (from a live access log). */
export function renderTerminalReport(log: AccessLog): void {
  renderTerminalReportFromJson(renderJsonReport(log));
}

/** Print a previously-saved JSON report to stderr (used by `capwarden report`). */
export function renderTerminalReportFromJson(report: JsonReport): void {
  const pkgs = Object.keys(report.packages).sort();

  console.error(`\n${BOLD}╔══════════════════════════════════════════════╗${RESET}`);
  console.error(`${BOLD}║         CapWarden — Observe Report           ║${RESET}`);
  console.error(`${BOLD}╚══════════════════════════════════════════════╝${RESET}`);
  console.error(`${DIM}Generated: ${report.generatedAt}${RESET}`);
  console.error(`${DIM}Total accesses: ${report.totalAccesses}${RESET}\n`);

  if (pkgs.length === 0) {
    console.error(`${GREEN}✓ No dependency accesses recorded.${RESET}\n`);
    return;
  }

  for (const pkg of pkgs) {
    const p = report.packages[pkg];
    console.error(`${BOLD}${CYAN}  ${pkg}${RESET}`);

    if (p.env.length) {
      console.error(`    ${YELLOW}env${RESET}     ${p.env.join(', ')}`);
    }
    if (p.net.length) {
      console.error(`    ${YELLOW}net${RESET}     ${p.net.join(', ')}`);
    }
    if (p.fs.length) {
      const fsStr = p.fs.map((f) => `${f.mode}:${f.path}`).join(', ');
      console.error(`    ${YELLOW}fs${RESET}      ${fsStr}`);
    }
    if (p.proc.length) {
      console.error(`    ${YELLOW}proc${RESET}    ${p.proc.join(', ')}`);
    }
    if (p.install.length) {
      console.error(`    ${YELLOW}install${RESET} ${p.install.join(', ')}`);
    }
    console.error('');
  }
}

/** Print a policy diff with additions highlighted as the review signal (FR-18). */
export function renderPolicyDiff(diff: PolicyDiff): void {
  console.error(`\n${BOLD}CapWarden — Policy Diff${RESET}\n`);

  const hasAnything =
    diff.newPackages.length > 0 ||
    diff.removedPackages.length > 0 ||
    diff.changedPackages.length > 0;

  if (!hasAnything) {
    console.error(`${GREEN}✓ No capability changes detected.${RESET}\n`);
    return;
  }

  if (diff.newPackages.length > 0) {
    console.error(`${BOLD}${RED}▲ NEW packages (review required):${RESET}`);
    for (const pkg of diff.newPackages) {
      console.error(`  ${RED}+ ${pkg}${RESET}`);
    }
    console.error('');
  }

  if (diff.changedPackages.length > 0) {
    console.error(`${BOLD}Changed packages:${RESET}`);
    for (const changed of diff.changedPackages) {
      console.error(`  ${CYAN}${changed.packageName}${RESET}`);
      for (const kind of changed.added) {
        console.error(`    ${RED}+ ${kind}${RESET}  ${DIM}← NEW capability${RESET}`);
      }
      for (const kind of changed.removed) {
        console.error(`    ${GREEN}- ${kind}${RESET}  ${DIM}← removed${RESET}`);
      }
    }
    console.error('');
  }

  if (diff.removedPackages.length > 0) {
    console.error(`${BOLD}${GREEN}▼ Removed packages (no longer need capabilities):${RESET}`);
    for (const pkg of diff.removedPackages) {
      console.error(`  ${GREEN}- ${pkg}${RESET}`);
    }
    console.error('');
  }

  console.error(
    `${BOLD}To update the policy:${RESET}  ${DIM}review the additions above, then run \`capwarden update\` and commit the diff.${RESET}\n`
  );
}
