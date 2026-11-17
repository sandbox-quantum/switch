import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalServerBundle } from './bundle';
import { type NativeLayout, nativeLayout } from './native-paths';
import { type PostgresBinaries, resolvePostgres } from './postgres-binaries';

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** A directory holding `initdb`, `pg_ctl` and a `postgres` that reports `major`. */
async function fakeBinDir(binDir: string, major: number): Promise<string> {
  await mkdir(binDir, { recursive: true });
  for (const name of ['initdb', 'pg_ctl']) {
    await writeFile(path.join(binDir, name), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(binDir, name), 0o755);
  }
  await writeFile(
    path.join(binDir, 'postgres'),
    `#!/bin/sh\necho "postgres (PostgreSQL) ${major}.4"\n`
  );
  await chmod(path.join(binDir, 'postgres'), 0o755);
  return binDir;
}

/** A copy of the app's bundle under the server's toolchain, shipping PostgreSQL `major`. */
async function bundleCopy(layout: NativeLayout, id: string, major: number) {
  const root = path.join(layout.toolchain, `bundle-${id}`);
  const binDir = await fakeBinDir(path.join(root, 'postgres', 'bin'), major);
  return { root, postgresBinDir: binDir, postgresVersion: `${major}.4.0` } as LocalServerBundle;
}

async function recordedChoice(layout: NativeLayout): Promise<PostgresBinaries> {
  return JSON.parse(await readFile(path.join(layout.run, 'postgres.json'), 'utf8'));
}

async function writeChoice(layout: NativeLayout, choice: PostgresBinaries): Promise<void> {
  await mkdir(layout.run, { recursive: true });
  await writeFile(path.join(layout.run, 'postgres.json'), JSON.stringify(choice));
}

async function existingCluster(layout: NativeLayout, major: number): Promise<void> {
  await mkdir(layout.pgdata, { recursive: true });
  await writeFile(path.join(layout.pgdata, 'PG_VERSION'), `${major}\n`);
}

describe.skipIf(process.platform === 'win32')('resolvePostgres after an update', () => {
  let root: string;
  let layout: NativeLayout;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'switch-resolve-pg-'));
    layout = nativeLayout(path.join(root, 'server'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('moves a server recorded on an older bundle to this build’s copy', async () => {
    await existingCluster(layout, 16);
    const older = await bundleCopy(layout, 'older', 16);
    const current = await bundleCopy(layout, 'current', 16);
    await writeChoice(layout, { binDir: older.postgresBinDir!, major: 16, source: 'bundled' });

    const chosen = await resolvePostgres(layout, current, () => {});

    expect(chosen).toEqual({ binDir: current.postgresBinDir, major: 16, source: 'bundled' });
    expect(await recordedChoice(layout)).toEqual(chosen);
  });

  it('keeps a server on an older bundle’s copy when this build ships another major', async () => {
    await existingCluster(layout, 16);
    const older = await bundleCopy(layout, 'older', 16);
    const current = await bundleCopy(layout, 'current', 17);
    const recorded: PostgresBinaries = {
      binDir: older.postgresBinDir!,
      major: 16,
      source: 'bundled',
    };
    await writeChoice(layout, recorded);

    expect(await resolvePostgres(layout, current, () => {})).toEqual(recorded);
  });

  it('keeps a server recorded on this build’s copy where it is', async () => {
    await existingCluster(layout, 16);
    const current = await bundleCopy(layout, 'current', 16);
    const recorded: PostgresBinaries = {
      binDir: current.postgresBinDir!,
      major: 16,
      source: 'bundled',
    };
    await writeChoice(layout, recorded);

    expect(await resolvePostgres(layout, current, () => {})).toEqual(recorded);
  });

  it('keeps a server created on an installed PostgreSQL 17 on it', async () => {
    const homebrew = await fakeBinDir(path.join(root, 'homebrew', 'postgresql@17', 'bin'), 17);
    await existingCluster(layout, 17);
    await writeChoice(layout, { binDir: homebrew, major: 17, source: 'installed' });
    const current = await bundleCopy(layout, 'current', 17);

    const chosen = await resolvePostgres(layout, current, () => {});

    expect(chosen).toEqual({ binDir: homebrew, major: 17, source: 'installed' });
  });

  it('keeps a dev build’s downloaded PostgreSQL, with no bundle to move to', async () => {
    await existingCluster(layout, 16);
    const downloaded = await fakeBinDir(path.join(layout.toolchain, 'postgres-16', 'bin'), 16);
    const recorded: PostgresBinaries = { binDir: downloaded, major: 16, source: 'downloaded' };
    await writeChoice(layout, recorded);

    expect(await resolvePostgres(layout, null, () => {})).toEqual(recorded);
  });
});
