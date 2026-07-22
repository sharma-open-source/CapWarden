/**
 * Install-script inventory — walks node_modules to find packages that declare
 * lifecycle scripts (preinstall, install, postinstall).
 *
 * Persists the inventory alongside the policy. On `capwarden update`, the diff
 * flags any newly added lifecycle scripts as review-required (FR-14, FR-15).
 */

import * as fs from 'fs';
import * as path from 'path';

export interface InstallScriptEntry {
  packageName: string;
  version: string;
  scripts: string[];
}

export interface InstallInventory {
  generatedAt: string;
  packages: InstallScriptEntry[];
}

const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

/**
 * Walk node_modules (including nested installs) and return packages that
 * declare lifecycle scripts. Transitive dependencies hoisted or nested deep in
 * the tree are covered by construction (§10.3), deduped by name@version.
 */
export function buildInstallInventory(nodeModulesDir: string): InstallInventory {
  const seen = new Map<string, InstallScriptEntry>();

  const scanNodeModules = (nmDir: string, depth: number): void => {
    if (depth > 32 || !fs.existsSync(nmDir)) return; // guard against symlink cycles

    let items: string[];
    try {
      items = fs.readdirSync(nmDir);
    } catch {
      return;
    }

    const scanPackage = (itemPath: string, fallbackName: string): void => {
      const pkgJsonPath = path.join(itemPath, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        let pkg: { name?: string; version?: string; scripts?: Record<string, string> };
        try {
          pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as typeof pkg;
          const scripts = Object.keys(pkg.scripts ?? {}).filter((s) =>
            LIFECYCLE_SCRIPTS.includes(s)
          );
          if (scripts.length > 0) {
            const name = pkg.name ?? fallbackName;
            const version = pkg.version ?? 'unknown';
            seen.set(`${name}@${version}`, { packageName: name, version, scripts });
          }
        } catch {
          /* skip unreadable package.json */
        }
      }
      // Recurse into this package's own nested node_modules.
      scanNodeModules(path.join(itemPath, 'node_modules'), depth + 1);
    };

    for (const item of items) {
      if (item === '.bin') continue;
      const itemPath = path.join(nmDir, item);

      // Scoped packages (@scope/name): descend one level.
      if (item.startsWith('@')) {
        let scoped: string[] = [];
        try {
          scoped = fs.readdirSync(itemPath);
        } catch {
          continue;
        }
        for (const sub of scoped) {
          scanPackage(path.join(itemPath, sub), `${item}/${sub}`);
        }
        continue;
      }

      scanPackage(itemPath, item);
    }
  };

  scanNodeModules(nodeModulesDir, 0);

  const entries = [...seen.values()].sort((a, b) =>
    a.packageName.localeCompare(b.packageName)
  );
  return { generatedAt: new Date().toISOString(), packages: entries };
}

/** Diff two inventories, returning newly added lifecycle-script packages. */
export function diffInventory(
  oldInventory: InstallInventory,
  newInventory: InstallInventory
): InstallScriptEntry[] {
  const oldNames = new Set(oldInventory.packages.map((p) => p.packageName));
  return newInventory.packages.filter((p) => !oldNames.has(p.packageName));
}
