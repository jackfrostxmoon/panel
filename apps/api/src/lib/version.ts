import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runtime version info, surfaced via /api/health.
 *
 * - `app` comes from the root package.json.
 * - `commit` / `builtAt` / `packageVersion` come from a `manifest.json` in the
 *   app root, if one is stamped there at build time. In a normal checkout
 *   there is no manifest — those fields are simply null.
 *
 * Resolved once per process and cached.
 */

const here = dirname(fileURLToPath(import.meta.url)); // apps/api/src/lib
// lib -> src -> api -> apps -> package/repo root
const rootPackageJson = join(here, '../../../../package.json');
const manifestJson = join(here, '../../../../manifest.json');

export interface VersionInfo {
  /** Application version (root package.json / git release tag). */
  app: string;
  /** Git commit the package was built from (when a manifest is stamped). */
  commit: string | null;
  /** Package layout/schema version (when a manifest is stamped). */
  packageVersion: number | null;
  /** ISO build timestamp (when a manifest is stamped). */
  builtAt: string | null;
  /** Bun runtime version. */
  bun: string;
}

let cached: VersionInfo | null = null;

export function getVersionInfo(): VersionInfo {
  if (cached) return cached;

  let app = '0.0.0';
  try {
    app = (JSON.parse(readFileSync(rootPackageJson, 'utf8')) as { version?: string }).version ?? app;
  } catch {
    // Missing/unreadable package.json — keep the fallback.
  }

  let commit: string | null = null;
  let packageVersion: number | null = null;
  let builtAt: string | null = null;
  try {
    if (existsSync(manifestJson)) {
      // Strip a potential UTF-8 BOM (PowerShell 5.1 Set-Content -Encoding
      // utf8 writes one) - JSON.parse rejects it otherwise.
      const raw = readFileSync(manifestJson, 'utf8').replace(/^\uFEFF/, '');
      const manifest = JSON.parse(raw) as {
        appVersion?: string;
        gitCommit?: string;
        packageVersion?: number;
        builtAt?: string;
      };
      // The manifest's appVersion (the released version, if stamped) is
      // authoritative; package.json is the fallback.
      app = manifest.appVersion ?? app;
      commit = manifest.gitCommit ?? null;
      packageVersion = manifest.packageVersion ?? null;
      builtAt = manifest.builtAt ?? null;
    }
  } catch {
    // Corrupt manifest — report the rest rather than failing health.
  }

  cached = { app, commit, packageVersion, builtAt, bun: Bun.version };
  return cached;
}