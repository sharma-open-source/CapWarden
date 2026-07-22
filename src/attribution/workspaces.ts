/**
 * Monorepo / workspace awareness (Open Q3).
 *
 * In a workspace repo, sibling packages (`packages/*`) are installed into
 * `node_modules` as symlinks. To attribution they look exactly like third-party
 * dependencies — but they are *first-party* code the team authors and reviews,
 * so charging them for capability use would be noise. This module discovers the
 * local workspace package names so attribution can fold them back into 'app'.
 *
 * Supported layouts:
 *   - npm / yarn / bun: `"workspaces"` in the root package.json (array, or
 *     `{ "packages": [...] }`).
 *   - pnpm: `packages:` globs in `pnpm-workspace.yaml` (minimal parser).
 *
 * Glob support is intentionally small: a trailing `/*` expands one directory
 * level; anything else is treated as a literal package directory. Reads only.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The set of local workspace package names to treat as first-party. */
const firstPartyPackages = new Set<string>();

/** Register package names that should be attributed to 'app', not themselves. */
export function setFirstPartyPackages(names: Iterable<string>): void {
  for (const n of names) firstPartyPackages.add(n);
}

/** True when a resolved package name is a local workspace (first-party). */
export function isFirstPartyPackage(name: string): boolean {
  return firstPartyPackages.has(name);
}

/** Test-only: clear the registered first-party set. */
export function _resetFirstPartyPackages(): void {
  firstPartyPackages.clear();
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function expandGlob(root: string, pattern: string): string[] {
  // Normalize and strip a leading ./
  const clean = pattern.replace(/^\.\//, '').replace(/\\/g, '/');
  if (clean.endsWith('/*')) {
    const base = path.join(root, clean.slice(0, -2));
    try {
      return fs
        .readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .map((d) => path.join(base, d.name));
    } catch {
      return [];
    }
  }
  return [path.join(root, clean)];
}

function nameOf(pkgDir: string): string | null {
  const pkg = readJson(path.join(pkgDir, 'package.json'));
  return typeof pkg?.['name'] === 'string' ? (pkg['name'] as string) : null;
}

/** Minimal `pnpm-workspace.yaml` `packages:` list parser (no YAML dependency). */
function parsePnpmWorkspaceGlobs(yaml: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '');
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line);
      if (m) {
        globs.push(m[1]);
      } else if (/^\S/.test(line)) {
        break; // dedented to a new top-level key
      }
    }
  }
  return globs;
}

/**
 * Discover local workspace package names rooted at `cwd`. Returns an empty array
 * for a non-workspace project. Never throws.
 */
export function discoverWorkspacePackages(cwd: string): string[] {
  const globs: string[] = [];

  const rootPkg = readJson(path.join(cwd, 'package.json'));
  const ws = rootPkg?.['workspaces'];
  if (Array.isArray(ws)) {
    globs.push(...ws.filter((w): w is string => typeof w === 'string'));
  } else if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)) {
    globs.push(...((ws as { packages: unknown[] }).packages.filter((w) => typeof w === 'string') as string[]));
  }

  const pnpmPath = path.join(cwd, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmPath)) {
    try {
      globs.push(...parsePnpmWorkspaceGlobs(fs.readFileSync(pnpmPath, 'utf-8')));
    } catch {
      /* ignore unreadable workspace file */
    }
  }

  const names = new Set<string>();
  for (const glob of globs) {
    for (const dir of expandGlob(cwd, glob)) {
      const name = nameOf(dir);
      if (name) names.add(name);
    }
  }
  return [...names];
}
