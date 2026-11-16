import { type ChildProcess, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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

  describe.skipIf(!['darwin', 'linux'].includes(process.platform))(
    'with a postmaster running from an older copy',
    () => {
      let postmaster: ChildProcess | null = null;

      afterEach(() => {
        postmaster?.kill('SIGKILL');
        postmaster = null;
      });

      it('keeps the copy the running postmaster was started from', async () => {
        const older = await bundleDir('older');
        await bundleDir('oldest');
        const current = await bundleDir('current');
        // A stand-in postmaster: a long sleep, run from the older copy's bin/.
        // macOS reports the path a process was started by; Linux resolves
        // links, so it gets a copy instead.
        const binary = path.join(older, 'postgres', 'bin', 'postgres');
        if (process.platform === 'darwin') await symlink('/bin/sleep', binary);
        else await copyFile('/bin/sleep', binary);
        postmaster = spawn(binary, ['60'], { stdio: 'ignore' });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await mkdir(layout.pgdata, { recursive: true });
        await writeFile(
          path.join(layout.pgdata, 'postmaster.pid'),
          `${postmaster.pid}\n${layout.pgdata}\n`
        );

        const running = await runningPostmasterBinary(layout);
        expect(running).toBe(binary);
        // The recorded choice already points at the current copy, as after an
        // update: only the running process says the older one is in use.
        await pruneBundleCopies(layout.toolchain, current, [
          path.join(current, 'postgres', 'bin'),
          running!,
        ]);

        expect((await readdir(layout.toolchain)).sort()).toEqual([
          'bundle-current',
          'bundle-older',
        ]);
      });
    }
  );
});
