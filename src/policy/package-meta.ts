/**
 * Best-effort resolvers for v2 policy provenance: read a dependency's installed
 * `package.json` to recover its version and whether it declares a lifecycle
 * install script. Reads are cached and never throw — an unresolved package
 * simply yields `undefined`, and generation falls back to a name-only key.
 */

import * as fs from 'fs';
import * as path from 'path';

const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const;

interface PackageMeta {
  version?: string;
  hasInstallScript: boolean;
}

export interface PackageMetaResolvers {
  resolveVersion: (packageName: string) => string | undefined;
  hasInstallScript: (packageName: string) => boolean | undefined;
}

export function makePackageMetaResolvers(cwd: string): PackageMetaResolvers {
  const nodeModules = path.join(cwd, 'node_modules');
  const cache = new Map<string, PackageMeta | null>();

  const read = (name: string): PackageMeta | null => {
    if (cache.has(name)) return cache.get(name) ?? null;
    let meta: PackageMeta | null = null;
    try {
      const pkgJson = path.join(nodeModules, ...name.split('/'), 'package.json');
      const raw = JSON.parse(fs.readFileSync(pkgJson, 'utf-8')) as {
        version?: string;
        scripts?: Record<string, string>;
      };
      const scripts = raw.scripts ?? {};
      meta = {
        version: raw.version,
        hasInstallScript: LIFECYCLE_SCRIPTS.some((s) => typeof scripts[s] === 'string'),
      };
    } catch {
      meta = null;
    }
    cache.set(name, meta);
    return meta;
  };

  return {
    resolveVersion: (name) => read(name)?.version,
    hasInstallScript: (name) => {
      const meta = read(name);
      return meta ? meta.hasInstallScript : undefined;
    },
  };
}
