/**
 * Machine-readable JSON report (FR-16).
 *
 * Never includes env values or file contents — only keys/paths/metadata (NFR-5).
 */

import type { AccessLog, CapabilityKind } from '../types.js';

export interface JsonReportPackage {
  env: string[];
  net: string[];
  fs: { path: string; mode: 'read' | 'write' }[];
  proc: string[];
  install: string[];
}

export interface JsonReport {
  generatedAt: string;
  totalAccesses: number;
  packages: Record<string, JsonReportPackage>;
}

export function renderJsonReport(log: AccessLog): JsonReport {
  const packages: Record<string, JsonReportPackage> = {};

  const get = (pkg: string): JsonReportPackage => {
    if (!packages[pkg]) {
      packages[pkg] = { env: [], net: [], fs: [], proc: [], install: [] };
    }
    return packages[pkg];
  };

  for (const event of log) {
    if (event.packageName === 'app') continue;
    const p = get(event.packageName);

    switch (event.detail.kind) {
      case 'env':
        if (!p.env.includes(event.detail.key)) p.env.push(event.detail.key);
        break;
      case 'net': {
        const addr = `${event.detail.host}:${event.detail.port}`;
        if (!p.net.includes(addr)) p.net.push(addr);
        break;
      }
      case 'fs': {
        const fsDetail = event.detail;
        const exists = p.fs.some((e) => e.path === fsDetail.path && e.mode === fsDetail.mode);
        if (!exists) p.fs.push({ path: fsDetail.path, mode: fsDetail.mode });
        break;
      }
      case 'proc':
        if (!p.proc.includes(event.detail.command)) p.proc.push(event.detail.command);
        break;
      case 'install': {
        const label = `${event.detail.packageName}:${event.detail.script}`;
        if (!p.install.includes(label)) p.install.push(label);
        break;
      }
    }
  }

  // Sort for determinism
  for (const p of Object.values(packages)) {
    p.env.sort();
    p.net.sort();
    p.fs.sort((a, b) => a.path.localeCompare(b.path));
    p.proc.sort();
    p.install.sort();
  }

  return {
    generatedAt: new Date().toISOString(),
    totalAccesses: log.length,
    packages,
  };
}

/** Return the set of capability kinds a package used (for policy generation preview). */
export function kindsUsed(pkgReport: JsonReportPackage): CapabilityKind[] {
  const kinds: CapabilityKind[] = [];
  if (pkgReport.env.length) kinds.push('env');
  if (pkgReport.net.length) kinds.push('net');
  if (pkgReport.fs.length) kinds.push('fs');
  if (pkgReport.proc.length) kinds.push('proc');
  if (pkgReport.install.length) kinds.push('install');
  return kinds;
}
