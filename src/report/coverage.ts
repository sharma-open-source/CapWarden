/**
 * Instrumentation-coverage report (R5).
 *
 * CapWarden intercepts capabilities at the JavaScript/CJS boundary. Two classes
 * of dependency fall partly or wholly outside that boundary, and honesty about
 * them is a security property — a silent blind spot is worse than a named one:
 *
 *   - **native addons** (`.node` binaries / `binding.gyp` / `gypfile`): code runs
 *     below the JS layer and can perform syscalls CapWarden never sees.
 *   - **ESM-only packages** (`"type":"module"` with no CJS entry): the GA
 *     AsyncLocalStorage attribution hooks `require()`, so a pure-ESM dependency
 *     reached only via `import` is attributed by stack-walk alone (weaker).
 *
 * This report enumerates those packages so a reviewer knows where the guard is
 * partial. It reads metadata only (NFR-5).
 */

import * as fs from 'fs';
import * as path from 'path';

export type CoverageLimitation = 'native-addon' | 'esm-only';

export interface CoverageEntry {
  packageName: string;
  version: string;
  limitations: CoverageLimitation[];
}

export interface CoverageReport {
  generatedAt: string;
  /** Packages with reduced instrumentation coverage. */
  partial: CoverageEntry[];
}

interface PkgJson {
  name?: string;
  version?: string;
  type?: string;
  main?: string;
  exports?: unknown;
  gypfile?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function hasNativeAddon(pkgDir: string, pkg: PkgJson): boolean {
  if (pkg.gypfile === true) return true;
  if (fs.existsSync(path.join(pkgDir, 'binding.gyp'))) return true;
  if ((pkg.dependencies ?? {})['node-gyp-build'] || (pkg.dependencies ?? {})['prebuild-install']) {
    return true;
  }
  for (const dir of ['build', 'prebuilds', 'bin']) {
    const p = path.join(pkgDir, dir);
    if (fs.existsSync(p) && containsDotNode(p, 0)) return true;
  }
  return false;
}

function containsDotNode(dir: string, depth: number): boolean {
  if (depth > 4) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.node')) return true;
    if (e.isDirectory() && containsDotNode(path.join(dir, e.name), depth + 1)) return true;
  }
  return false;
}

function isEsmOnly(pkg: PkgJson): boolean {
  if (pkg.type !== 'module') return false;
  // A `.cjs` main or a `require` condition in `exports` means a CJS entry that
  // the require()-based attribution hook still covers.
  if (typeof pkg.main === 'string' && pkg.main.endsWith('.cjs')) return false;
  if (JSON.stringify(pkg.exports ?? '').includes('"require"')) return false;
  return true;
}

/** Walk node_modules and report packages with reduced instrumentation coverage. */
export function buildCoverageReport(nodeModulesDir: string): CoverageReport {
  const seen = new Map<string, CoverageEntry>();

  const scanPackage = (pkgDir: string, fallbackName: string): void => {
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      let pkg: PkgJson;
      try {
        pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as PkgJson;
      } catch {
        return scanNested(pkgDir);
      }
      const limitations: CoverageLimitation[] = [];
      if (hasNativeAddon(pkgDir, pkg)) limitations.push('native-addon');
      if (isEsmOnly(pkg)) limitations.push('esm-only');
      if (limitations.length > 0) {
        const name = pkg.name ?? fallbackName;
        const version = pkg.version ?? 'unknown';
        seen.set(`${name}@${version}`, { packageName: name, version, limitations });
      }
    }
    scanNested(pkgDir);
  };

  const scanNested = (pkgDir: string): void => scan(path.join(pkgDir, 'node_modules'), 0);

  const scan = (nmDir: string, depth: number): void => {
    if (depth > 32 || !fs.existsSync(nmDir)) return;
    let items: string[];
    try {
      items = fs.readdirSync(nmDir);
    } catch {
      return;
    }
    for (const item of items) {
      if (item === '.bin') continue;
      const itemPath = path.join(nmDir, item);
      if (item.startsWith('@')) {
        let scoped: string[] = [];
        try {
          scoped = fs.readdirSync(itemPath);
        } catch {
          continue;
        }
        for (const sub of scoped) scanPackage(path.join(itemPath, sub), `${item}/${sub}`);
        continue;
      }
      scanPackage(itemPath, item);
    }
  };

  scan(nodeModulesDir, 0);

  const partial = [...seen.values()].sort((a, b) => a.packageName.localeCompare(b.packageName));
  return { generatedAt: new Date().toISOString(), partial };
}
