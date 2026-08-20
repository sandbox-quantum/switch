#!/usr/bin/env node
/**
 * Combine the per-architecture macOS update manifests into the single
 * `latest-mac.yml` electron-updater reads.
 *
 *   node --experimental-strip-types scripts/merge-mac-update-manifest.ts \
 *     --out latest-mac.yml arm64=<path> x64=<path>
 *
 * electron-builder gives Linux a per-arch channel file (`latest-linux-arm64.yml`)
 * but macOS none — `getArchPrefixForUpdateFile` returns an empty suffix for every
 * platform except Linux, so an arm64 build and an x64 build both write
 * `latest-mac.yml`. Uploading both to a Release leaves whichever finished last as
 * the only manifest, and the other architecture stops receiving updates with no
 * error anywhere: the version check still passes, and the download then fails
 * with ERR_UPDATER_NO_FILES_PROVIDED once the updater has filtered the file list
 * down to nothing.
 *
 * electron-updater's mac path expects one manifest listing every architecture. It
 * picks a download by looking for `arm64` in the file name — Intel machines drop
 * those entries, Apple silicon (including under Rosetta) prefers them — so the
 * two manifests are combined here rather than published separately.
 *
 * The first input is the base document: its `version`, `releaseDate` and the
 * legacy top-level `path`/`sha512` survive, and every other input contributes
 * only its `files` entries. Pass arm64 first, so those top-level fields keep
 * naming what they have always named. They can only ever name one architecture,
 * so they are wrong for the other by construction — which is harmless because
 * every client reads `files`; `path` is only consulted for a manifest that has no
 * `files` at all.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dump, load } from 'js-yaml';

export interface UpdateManifestFile {
  url: string;
  sha512: string;
  size: number;
  [key: string]: unknown;
}

export interface UpdateManifest {
  version: string;
  files: UpdateManifestFile[];
  path: string;
  sha512: string;
  releaseDate: string;
  [key: string]: unknown;
}

export interface ManifestInput {
  /** Architecture the manifest was built for, as electron-builder names it. */
  arch: string;
  /** Where it came from, for error messages. */
  source: string;
  text: string;
}

const ARM64_MARKER = 'arm64';

function fail(message: string): never {
  throw new Error(`merge-mac-update-manifest: ${message}`);
}

function parseManifest(input: ManifestInput): UpdateManifest {
  let parsed: unknown;
  try {
    parsed = load(input.text);
  } catch (cause) {
    fail(`${input.source} is not valid YAML: ${(cause as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    fail(`${input.source} does not contain a mapping`);
  }
  const manifest = parsed as UpdateManifest;
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    fail(`${input.source} has no version`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail(`${input.source} lists no files`);
  }
  for (const file of manifest.files) {
    if (file === null || typeof file !== 'object' || typeof file.url !== 'string') {
      fail(`${input.source} has a file entry without a url`);
    }
    // electron-updater rejects a checksum-less entry with ERR_UPDATER_NO_CHECKSUM
    // on the user's machine. Catch it while it is still a build failure.
    if (typeof file.sha512 !== 'string' || file.sha512 === '') {
      fail(`${input.source} lists '${file.url}' without a sha512`);
    }
  }
  return manifest;
}

/**
 * The routing rule electron-updater applies, asserted at build time: an arm64
 * manifest must name arm64 in every url, and no other architecture may. A build
 * that violates it produces a manifest that sends one architecture the other's
 * download.
 */
function assertArchNaming(input: ManifestInput, manifest: UpdateManifest): void {
  const wantsArm64 = input.arch === ARM64_MARKER;
  for (const file of manifest.files) {
    const namesArm64 = file.url.includes(ARM64_MARKER);
    if (namesArm64 !== wantsArm64) {
      fail(
        `${input.source} was declared ${input.arch} but lists '${file.url}'. ` +
          `electron-updater routes macOS downloads on whether the file name contains '${ARM64_MARKER}', ` +
          `so this manifest would send the wrong build to one architecture.`
      );
    }
  }
  if (!manifest.files.some((file) => file.url.endsWith('.zip'))) {
    fail(
      `${input.source} lists no .zip — electron-updater installs macOS updates from the zip, not the dmg`
    );
  }
}

export function mergeMacUpdateManifests(inputs: ManifestInput[]): string {
  if (inputs.length < 2) {
    fail(`expected at least two manifests to merge, got ${inputs.length}`);
  }
  if (!inputs.some((input) => input.arch === ARM64_MARKER)) {
    fail(
      `no ${ARM64_MARKER} manifest among the inputs — refusing to publish a macOS manifest without it`
    );
  }

  const [base, ...rest] = inputs.map((input) => {
    const manifest = parseManifest(input);
    assertArchNaming(input, manifest);
    return { input, manifest };
  });

  const files: UpdateManifestFile[] = [];
  const seen = new Map<string, string>();
  for (const { input, manifest } of [base, ...rest]) {
    if (manifest.version !== base.manifest.version) {
      fail(
        `version mismatch: ${base.input.source} is ${base.manifest.version}, ` +
          `${input.source} is ${manifest.version}`
      );
    }
    for (const file of manifest.files) {
      const previous = seen.get(file.url);
      if (previous !== undefined) {
        fail(`'${file.url}' appears in both ${previous} and ${input.source}`);
      }
      seen.set(file.url, input.source);
      files.push(file);
    }
  }

  // `lineWidth` matches builder-util's own serializeToYaml, so the merged file is
  // written the way electron-builder writes the ones it feeds in — at the default
  // width a sha512 wraps into a folded block scalar.
  return dump({ ...base.manifest, files }, { lineWidth: 8000 });
}

function parseArgs(argv: string[]): { out: string; inputs: ManifestInput[] } {
  let out = '';
  const inputs: ManifestInput[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      out = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    const separator = arg.indexOf('=');
    if (separator <= 0) {
      fail(`unrecognised argument '${arg}' — expected --out <path> and <arch>=<path> pairs`);
    }
    const path = arg.slice(separator + 1);
    inputs.push({ arch: arg.slice(0, separator), source: path, text: readFileSync(path, 'utf8') });
  }
  if (out === '') {
    fail('--out <path> is required');
  }
  return { out, inputs };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { out, inputs } = parseArgs(process.argv.slice(2));
  writeFileSync(out, mergeMacUpdateManifests(inputs));
  console.log(
    `merge-mac-update-manifest: wrote ${out} from ${inputs.map((i) => i.arch).join(', ')}`
  );
}
