import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  type ManifestInput,
  type UpdateManifest,
  mergeMacUpdateManifests,
} from './merge-mac-update-manifest';

function manifest(arch: string, version = '0.28.0'): string {
  return [
    `version: ${version}`,
    'files:',
    `  - url: switch-console-${arch}.zip`,
    '    sha512: zip-checksum-' + arch,
    '    size: 147344955',
    `  - url: switch-console-${arch}.dmg`,
    '    sha512: dmg-checksum-' + arch,
    '    size: 148693658',
    `path: switch-console-${arch}.zip`,
    `sha512: zip-checksum-${arch}`,
    "releaseDate: '2026-08-18T08:53:14.463Z'",
    '',
  ].join('\n');
}

function input(arch: string, text = manifest(arch)): ManifestInput {
  return { arch, source: `${arch}/latest-mac.yml`, text };
}

describe('mergeMacUpdateManifests', () => {
  it('lists every architecture in one manifest', () => {
    const merged = load(mergeMacUpdateManifests([input('arm64'), input('x64')])) as UpdateManifest;

    expect(merged.files.map((file) => file.url)).toEqual([
      'switch-console-arm64.zip',
      'switch-console-arm64.dmg',
      'switch-console-x64.zip',
      'switch-console-x64.dmg',
    ]);
  });

  it('keeps the first input as the base document', () => {
    const merged = load(mergeMacUpdateManifests([input('arm64'), input('x64')])) as UpdateManifest;

    expect(merged.version).toBe('0.28.0');
    expect(merged.path).toBe('switch-console-arm64.zip');
    expect(merged.sha512).toBe('zip-checksum-arm64');
    expect(merged.releaseDate).toBe('2026-08-18T08:53:14.463Z');
  });

  it('leaves each architecture a zip to install from', () => {
    const merged = load(mergeMacUpdateManifests([input('arm64'), input('x64')])) as UpdateManifest;
    const forIntel = merged.files.filter((file) => !file.url.includes('arm64'));
    const forAppleSilicon = merged.files.filter((file) => file.url.includes('arm64'));

    expect(forIntel.some((file) => file.url.endsWith('.zip'))).toBe(true);
    expect(forAppleSilicon.some((file) => file.url.endsWith('.zip'))).toBe(true);
  });

  it('refuses a manifest whose files contradict its declared architecture', () => {
    expect(() =>
      mergeMacUpdateManifests([input('arm64'), input('x64', manifest('arm64'))])
    ).toThrow(/declared x64 but lists 'switch-console-arm64.zip'/);
  });

  it('refuses to publish without the arm64 manifest', () => {
    expect(() => mergeMacUpdateManifests([input('x64'), input('universal')])).toThrow(
      /no arm64 manifest/
    );
  });

  it('refuses manifests built from different versions', () => {
    expect(() =>
      mergeMacUpdateManifests([input('arm64'), input('x64', manifest('x64', '0.27.1'))])
    ).toThrow(/version mismatch/);
  });

  it('refuses a single manifest', () => {
    expect(() => mergeMacUpdateManifests([input('arm64')])).toThrow(/at least two manifests/);
  });

  it('refuses an architecture that produced no zip', () => {
    const dmgOnly = [
      'version: 0.28.0',
      'files:',
      '  - url: switch-console-x64.dmg',
      '    sha512: dmg-checksum-x64',
      '    size: 148693658',
      'path: switch-console-x64.dmg',
      'sha512: dmg-checksum-x64',
      "releaseDate: '2026-08-18T08:53:14.463Z'",
      '',
    ].join('\n');

    expect(() => mergeMacUpdateManifests([input('arm64'), input('x64', dmgOnly)])).toThrow(
      /lists no .zip/
    );
  });

  it('refuses a file entry with no checksum', () => {
    const noChecksum = [
      'version: 0.28.0',
      'files:',
      '  - url: switch-console-x64.zip',
      '    size: 147344955',
      'path: switch-console-x64.zip',
      "releaseDate: '2026-08-18T08:53:14.463Z'",
      '',
    ].join('\n');

    expect(() => mergeMacUpdateManifests([input('arm64'), input('x64', noChecksum)])).toThrow(
      /without a sha512/
    );
  });

  it('refuses an empty manifest', () => {
    expect(() =>
      mergeMacUpdateManifests([input('arm64'), input('x64', 'version: 0.28.0\nfiles: []\n')])
    ).toThrow(/lists no files/);
  });
});
