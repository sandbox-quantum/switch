import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleCopyHolding, pruneBundleCopies } from './bundle';
import { type NativeLayout, nativeLayout } from './native-paths';
import { runningPostmasterBinary } from './postgres-cluster';

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

let root: string;
let layout: NativeLayout;

async function bundleDir(id: string): Promise<string> {
  const dir = path.join(layout.toolchain, `bundle-${id}`);
  await mkdir(path.join(dir, 'postgres', 'bin'), { recursive: true });
  await writeFile(path.join(dir, 'manifest.json'), '{}');
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'switch-prune-'));
  layout = nativeLayout(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('bundleCopyHolding', () => {
  it('names the bundle copy a file lies in, and nothing for a file outside one', () => {
    const toolchain = layout.toolchain;
    expect(
      bundleCopyHolding(toolchain, path.join(toolchain, 'bundle-abc', 'postgres', 'bin'))
    ).toBe(path.join(toolchain, 'bundle-abc'));
    expect(bundleCopyHolding(toolchain, path.join(toolchain, 'postgres-16', 'bin'))).toBeNull();
    expect(bundleCopyHolding(toolchain, '/opt/homebrew/opt/postgresql@17/bin')).toBeNull();
  });
});

describe('pruneBundleCopies', () => {
  it('removes older copies but keeps the one the recorded PostgreSQL runs from', async () => {
    const older = await bundleDir('older');
    await bundleDir('oldest');
    const current = await bundleDir('current');

    await pruneBundleCopies(layout.toolchain, current, [path.join(older, 'postgres', 'bin')]);

    expect((await readdir(layout.toolchain)).sort()).toEqual(['bundle-current', 'bundle-older']);
  });

  it('keeps the copy a running postmaster was started from, though the record has moved on', async () => {
    const older = await bundleDir('older');
    await bundleDir('oldest');
    const current = await bundleDir('current');

    // After an update the recorded choice already points at the current copy;
    // only the running postmaster says the older one is still in use.
    await pruneBundleCopies(layout.toolchain, current, [
      path.join(current, 'postgres', 'bin'),
      path.join(older, 'postgres', 'bin', 'postgres'),
    ]);

    expect((await readdir(layout.toolchain)).sort()).toEqual(['bundle-current', 'bundle-older']);
  });
});

describe.skipIf(process.platform === 'win32')('runningPostmasterBinary', () => {
  it('names the executable of the process postmaster.pid records', async () => {
    // This test's own process stands in for the postmaster: its executable is
    // known on every platform, and nothing has to be started or copied.
    await mkdir(layout.pgdata, { recursive: true });
    await writeFile(
      path.join(layout.pgdata, 'postmaster.pid'),
      `${process.pid}\n${layout.pgdata}\n`
    );

    const running = await runningPostmasterBinary(layout);

    expect(running).not.toBeNull();
    expect(await realpath(running!)).toBe(await realpath(process.execPath));
  });

  it('is null when no postmaster runs', async () => {
    expect(await runningPostmasterBinary(layout)).toBeNull();
    await mkdir(layout.pgdata, { recursive: true });
    await writeFile(path.join(layout.pgdata, 'postmaster.pid'), '999999999\n');
    expect(await runningPostmasterBinary(layout)).toBeNull();
  });
});
