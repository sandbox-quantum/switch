import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Hosted agents v2 keeps its own copies of the agent packages (the `-box`
 * packages), and only the box image builds from them. The desktop app and v1
 * machines build from upstream's four packages, so those must stay exactly as
 * upstream: every file present, none added, each byte for byte (the check for
 * the package split). The expected files are upstream's git blob
 * ids in `upstream-packages.json`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, '..', 'upstream-packages.json'), 'utf8')) as {
  upstream: string;
  packages: string[];
  files: Record<string, string>;
};
const packagesDir = join(here, '..', '..');

/** Build outputs and installs, which git never tracks in these packages. */
const UNTRACKED_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'dist-bench',
  'dist-package',
  '.turbo',
  'coverage',
]);
const UNTRACKED_FILES = (name: string) => name === '.DS_Store' || name.endsWith('.tsbuildinfo');

/** A file's git blob id: sha1 of `blob <size>\0` and its bytes. */
function blobId(path: string): string {
  const bytes = readFileSync(path);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!UNTRACKED_DIRS.has(name)) found.push(...filesUnder(path));
    } else if (!UNTRACKED_FILES(name)) {
      found.push(path);
    }
  }
  return found;
}

describe(`upstream's agent packages are exactly upstream ${manifest.upstream.slice(0, 9)}`, () => {
  it('lists the four packages the desktop app and v1 machines build from', () => {
    expect(manifest.packages).toEqual([
      'agent-controller',
      'agent-providers',
      'switch-agent-runtime',
      'shared',
    ]);
  });

  for (const pkg of manifest.packages) {
    it(`${pkg}: no file added, changed or missing`, () => {
      const actual = new Map(
        filesUnder(join(packagesDir, pkg)).map((path) => [
          relative(packagesDir, path).split(sep).join('/'),
          blobId(path),
        ])
      );
      const expected = Object.entries(manifest.files).filter(([path]) =>
        path.startsWith(`${pkg}/`)
      );
      const missing = expected.filter(([path]) => !actual.has(path)).map(([path]) => path);
      const changed = expected
        .filter(([path, blob]) => actual.has(path) && actual.get(path) !== blob)
        .map(([path]) => path);
      const added = [...actual.keys()].filter((path) => !(path in manifest.files));
      expect({ missing, changed, added }).toEqual({ missing: [], changed: [], added: [] });
    });
  }
});

/** Every workspace package.json under `console/`, apps and tooling included. */
function workspaceManifests(): { dir: string; json: Record<string, unknown> }[] {
  const consoleDir = join(packagesDir, '..');
  const found: { dir: string; json: Record<string, unknown> }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (!statSync(path).isDirectory()) continue;
      if (UNTRACKED_DIRS.has(name) || name.startsWith('.')) continue;
      const manifestPath = join(path, 'package.json');
      try {
        found.push({
          dir: relative(consoleDir, path).split(sep).join('/'),
          json: JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>,
        });
      } catch {
        // not a package
      }
      walk(path);
    }
  };
  walk(consoleDir);
  return found;
}

function dependencies(json: Record<string, unknown>): Record<string, string> {
  return Object.assign(
    {},
    ...(
      ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const
    ).map((key) => (json[key] ?? {}) as Record<string, string>)
  );
}

describe('the -box packages stay inside the box', () => {
  const manifests = workspaceManifests();
  const boxNames = new Set(
    manifests
      .filter(({ dir }) => dir.startsWith('packages/') && dir.endsWith('-box'))
      .map(({ json }) => String(json.name))
  );

  it('finds the box runtime among them', () => {
    expect(boxNames).toContain('@sandboxaq/switch-agent-runtime-box');
  });

  it('every -box package is private, so it is never published', () => {
    const notPrivate = manifests
      .filter(({ json }) => boxNames.has(String(json.name)) && json.private !== true)
      .map(({ dir }) => dir);
    expect(notPrivate).toEqual([]);
  });

  it('a -box package is only ever depended on as workspace:*, and only by another -box package', () => {
    const wrong: string[] = [];
    for (const { dir, json } of manifests) {
      for (const [name, range] of Object.entries(dependencies(json))) {
        if (!boxNames.has(name)) continue;
        if (range !== 'workspace:*') wrong.push(`${dir} -> ${name}@${range}`);
        if (!boxNames.has(String(json.name))) wrong.push(`${dir} (not a -box package) -> ${name}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("the desktop app's lockfile names no -box package", () => {
  it('apps/switch-console-desktop links only upstream packages', () => {
    const lock = readFileSync(join(packagesDir, '..', 'pnpm-lock.yaml'), 'utf8').split('\n');
    const start = lock.indexOf('  apps/switch-console-desktop:');
    expect(start).toBeGreaterThan(-1);
    const end = lock.findIndex((line, i) => i > start && /^ {2}\S/.test(line));
    const importer = lock.slice(start + 1, end === -1 ? undefined : end);
    expect(importer.filter((line) => /-box\b/.test(line))).toEqual([]);
  });
});
