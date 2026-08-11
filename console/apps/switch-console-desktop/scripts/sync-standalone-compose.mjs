#!/usr/bin/env node
/**
 * Sync the bundled standalone compose from the repo's source of truth.
 *
 *   node scripts/sync-standalone-compose.mjs           # write the bundled copy
 *   node scripts/sync-standalone-compose.mjs --check   # fail if it is stale
 *
 * Copies deploy/local/standalone-docker-compose.yml (the file the switch-release
 * workflow publishes to GHCR as `standalone-compose:<version>`) into
 * src/main/core/managed-switch-server/resources/, re-adding the "bundled copy"
 * header. Run this when bumping COMPATIBLE_SWITCH_VERSION so the bundled compose
 * stays in lockstep with the pinned switch-core release. It reads the repo file
 * directly rather than pulling the OCI artifact so it works offline and before a
 * release exists; the two are identical by construction.
 *
 * `--check` exists because nothing verified this had run (CHOO-1865). The two
 * copies could drift with only a comment asking nicely — which is exactly how
 * the rename below went unnoticed. It catches both directions: a source change
 * that was never synced, and a hand-edit to the bundled copy.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const source = resolve(repoRoot, 'deploy/local/standalone-docker-compose.yml');
const destDir = resolve(here, '../src/main/core/managed-switch-server/resources');
const dest = resolve(destDir, 'standalone-docker-compose.pinned.yml');

// Name the module rename explicitly: this script pointed at the old
// `local-switch-server` path long after it was renamed, so it silently never
// ran and the bundled compose drifted from source.
for (const [label, path] of [
  ['source compose', source],
  ['destination directory', destDir],
]) {
  if (!existsSync(path)) {
    console.error(
      `sync-standalone-compose: ${label} not found at ${path}\n` +
        'If a module was renamed, update this script to match.'
    );
    process.exit(1);
  }
}

const header = `# BUNDLED COPY — do not hand-edit. This is the standalone compose published to
# GHCR as \`standalone-compose:<version>\` by the switch-release workflow, pinned
# to COMPATIBLE_SWITCH_VERSION (src/shared/app-identity.ts) and bundled into the
# app so local-server mode needs no runtime OCI puller. Re-sync it from the
# repo's deploy/local/standalone-docker-compose.yml when bumping the pin
# (scripts/sync-standalone-compose.mjs).
#
`;

const expected = header + readFileSync(source, 'utf8');

if (process.argv.includes('--check')) {
  const actual = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
  if (actual !== expected) {
    console.error(
      `sync-standalone-compose: ${dest}\n` +
        'is out of date. Either the source compose changed without re-syncing, or\n' +
        'the bundled copy was hand-edited. Run `pnpm run sync:compose` and commit.'
    );
    process.exit(1);
  }
  console.log('Bundled standalone compose is up to date.');
  process.exit(0);
}

writeFileSync(dest, expected, 'utf8');
console.log(`Synced ${source}\n     -> ${dest}`);
