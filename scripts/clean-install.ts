/**
 * Clean reinstall: wipe every workspace node_modules dir, then reinstall
 * from the locked tree.
 *
 * Usage:
 *   bun run clean-install
 *
 * Why this exists: Bun keeps a central package store
 * (node_modules/.bun) plus per-workspace links into it. If those links go
 * stale (e.g. root node_modules was deleted and restored instead of
 * reinstalled), `bun install` reports "no changes" while `tsc` fails with
 * missing modules or mass implicit-any errors. Deleting only the root
 * node_modules makes it worse — it removes the store every workspace
 * points into. The fix is to wipe ALL workspace node_modules dirs together
 * and reinstall in one pass.
 *
 * Safety: only directories literally named `node_modules` inside this repo
 * are removed. The lockfile, `.env`, `data/`, and `dist/` are untouched,
 * and the global download cache is kept so the reinstall is fast.
 */
import { readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every node_modules dir Bun manages for this monorepo (root + workspaces). */
async function installDirs(): Promise<string[]> {
  const dirs = [path.join(root, 'node_modules')];
  for (const group of ['apps', 'packages']) {
    let entries;
    try {
      entries = await readdir(path.join(root, group), { withFileTypes: true });
    } catch {
      continue; // group dir missing — nothing to clean there
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(path.join(root, group, entry.name, 'node_modules'));
      }
    }
  }
  return dirs;
}

const dirs = await installDirs();
for (const dir of dirs) {
  // Paranoia guard: never delete anything that isn't a node_modules dir
  // inside this repo, no matter how the path logic above evolves.
  const resolved = path.resolve(dir);
  if (path.basename(resolved) !== 'node_modules' || !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to delete unexpected path: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
  console.info(`removed ${path.relative(root, resolved)}`);
}

// process.execPath is the Bun binary itself when run under Bun — more
// robust than resolving `bun` from PATH (especially on Windows).
const result = spawnSync(process.execPath, ['install'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.status !== 0) {
  console.error(`bun install failed with exit code ${result.status ?? 'unknown'}`);
  process.exit(result.status ?? 1);
}
console.info('clean install complete — run `bun run typecheck` to verify');
