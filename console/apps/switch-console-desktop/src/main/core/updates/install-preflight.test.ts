import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findInstallBlocker, macAppBundlePath } from './install-preflight';

describe('macAppBundlePath', () => {
  it('finds the bundle around the main executable', () => {
    expect(macAppBundlePath('/Applications/Switch Console.app/Contents/MacOS/Switch Console')).toBe(
      '/Applications/Switch Console.app'
    );
  });

  it('stops at the outer bundle, not a helper inside it', () => {
    expect(
      macAppBundlePath(
        '/Applications/Switch Console.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper'
      )
    ).toBe('/Applications/Switch Console.app');
  });

  it('returns null for an executable outside a bundle', () => {
    expect(macAppBundlePath('/usr/local/bin/node')).toBeNull();
  });
});

describe('findInstallBlocker', () => {
  const uid = process.getuid?.() ?? 0;
  let folder: string;
  let bundle: string;

  beforeEach(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), 'switch-console-preflight-'));
    bundle = path.join(folder, 'Switch Console.app');
    await mkdir(bundle);
  });

  afterEach(async () => {
    await chmod(folder, 0o755);
    await chmod(bundle, 0o755);
    await rm(folder, { recursive: true, force: true });
  });

  it('finds nothing in the way of a bundle this account owns and can replace', async () => {
    await expect(findInstallBlocker(bundle, uid)).resolves.toBeNull();
  });

  it('refuses a translocated bundle without looking at the disk', async () => {
    const translocated =
      '/private/var/folders/xy/abc/T/AppTranslocation/1234-5678/d/Switch Console.app';

    await expect(findInstallBlocker(translocated, uid)).resolves.toEqual({
      reason: 'translocated',
      bundlePath: translocated,
    });
  });

  it('refuses a bundle that belongs to another account', async () => {
    await expect(findInstallBlocker(bundle, uid + 1)).resolves.toEqual({
      reason: 'not_owned',
      bundlePath: bundle,
    });
  });

  // Root can write anywhere, so the permission bits prove nothing under it.
  it.skipIf(uid === 0)('refuses a bundle it cannot write', async () => {
    await chmod(bundle, 0o555);

    await expect(findInstallBlocker(bundle, uid)).resolves.toEqual({
      reason: 'not_writable',
      bundlePath: bundle,
      deniedPath: bundle,
    });
  });

  it.skipIf(uid === 0)('refuses a bundle whose folder it cannot write', async () => {
    await chmod(folder, 0o555);

    await expect(findInstallBlocker(bundle, uid)).resolves.toEqual({
      reason: 'not_writable',
      bundlePath: bundle,
      deniedPath: folder,
    });
  });
});
