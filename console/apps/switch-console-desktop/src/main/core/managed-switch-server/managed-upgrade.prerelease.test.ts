/**
 * The backups a start takes when the version that last ran a server's
 * database is a prerelease, or is not known at all, on a build pinned to a
 * prerelease (as every canary is).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppIdentity from '@shared/app-identity';
import type * as DeployedVersion from './deployed-version';
import type { ServerHost } from './host/types';

const deployed = vi.hoisted(() => vi.fn());
vi.mock('@shared/app-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof AppIdentity>()),
  COMPATIBLE_SWITCH_VERSION: '0.32.0-rc.7',
}));
vi.mock('./deployed-version', async (importOriginal) => ({
  ...(await importOriginal<typeof DeployedVersion>()),
  readDeployedVersion: deployed,
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { backUpUnknownDockerVersion, backUpUnknownVersion, prepareUpgrade } =
  await import('./managed-upgrade');
const { classifyVersionDrift } = await import('./deployed-version');
const { nativeUpgradeSource, readNativeDeployedVersion } = await import('./native/native-version');
const { nativeLayout } = await import('./native/native-paths');

type Exec = (
  command: string,
  args: string[],
  opts?: { env?: Record<string, string> }
) => Promise<{ stdout: string; stderr: string }>;

let directory: string;
let exec: ReturnType<typeof vi.fn<Exec>>;
let volumes: string;

function fakeHost(): ServerHost {
  return {
    kind: 'local',
    label: 'this computer',
    workingDir: directory,
    composeProjectName: 'test-stack',
    dockerBin: 'docker',
    ctx: { exec },
    readFile: async (name: string) =>
      readFile(join(directory, name), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
    writeFile: async (name: string, value: string) => {
      await mkdir(dirname(join(directory, name)), { recursive: true });
      await writeFile(join(directory, name), value);
    },
    removeFile: async (name: string) => rm(join(directory, name), { force: true }),
    restrictMode: async () => {},
  } as unknown as ServerHost;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'switch-prerelease-upgrade-'));
  volumes = 'test-stack_pgdata\ntest-stack_mmdata\n';
  exec = vi.fn<Exec>(async (_command, args) => {
    if (args[0] === 'volume') return { stdout: volumes, stderr: '' };
    if (args.includes('ps')) return { stdout: 'abc123\n', stderr: '' };
    if (args[0] === 'cp') await writeFile(join(directory, args[2]), '-- PostgreSQL database dump');
    return { stdout: '', stderr: '' };
  });
  const host = fakeHost();
  await host.writeFile('.env', 'SWITCH_VERSION=0.32.0-rc.5\n');
  await host.writeFile('standalone-docker-compose.yml', 'services: {}\n');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('a prerelease pin', () => {
  it('backs up a database last run by an earlier prerelease before updating it', async () => {
    deployed.mockResolvedValue({ kind: 'deployed', version: '0.32.0-rc.5', source: 'env-file' });
    const onUpgrade = vi.fn();

    const journal = await prepareUpgrade(fakeHost(), null, vi.fn(), onUpgrade);

    expect(onUpgrade).toHaveBeenCalledWith({ from: '0.32.0-rc.5', to: '0.32.0-rc.7' });
    expect(journal).toMatchObject({ from: '0.32.0-rc.5', to: '0.32.0-rc.7' });
    expect(await readFile(join(journal!.backup, 'database.sql'), 'utf8')).toContain('PostgreSQL');
  });

  it('refuses a database a later prerelease already ran, and takes no backup', async () => {
    deployed.mockResolvedValue({ kind: 'deployed', version: '0.32.0-rc.9', source: 'env-file' });

    expect(classifyVersionDrift('0.32.0-rc.9', '0.32.0-rc.7')?.direction).toBe('downgrade');
    expect(await prepareUpgrade(fakeHost(), null, vi.fn(), vi.fn())).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('backUpUnknownDockerVersion', () => {
  it('backs up a database whose version record cannot be read', async () => {
    deployed.mockResolvedValue({ kind: 'unreadable', reason: '.env: no SWITCH_VERSION entry' });
    await fakeHost().writeFile('.env', 'POSTGRES_PASSWORD=placeholder\n');
    const onMessage = vi.fn();

    const backup = await backUpUnknownDockerVersion(fakeHost(), null, onMessage);

    expect(backup).toMatch(/switch-core-unknown$/);
    expect(await readFile(join(backup!, 'database.sql'), 'utf8')).toContain('PostgreSQL');
    expect(await readFile(join(backup!, 'README.txt'), 'utf8')).toContain(
      'because nothing recorded which switch-core version last ran it'
    );
    expect(onMessage).toHaveBeenCalledWith(
      'Backing up the database: there is no record of which switch-core last ran it…'
    );
    // The `.env` no longer names a version, which the compose file requires.
    const up = exec.mock.calls.find(([, args]) => args.includes('up'));
    expect(up?.[2]?.env).toEqual({ SWITCH_VERSION: '0.32.0-rc.7' });
  });

  it('takes none when there is no database to back up', async () => {
    deployed.mockResolvedValue({ kind: 'unreadable', reason: '.env: no SWITCH_VERSION entry' });
    volumes = 'test-stack_mmdata\n';

    expect(await backUpUnknownDockerVersion(fakeHost(), null, vi.fn())).toBeNull();
    expect(exec.mock.calls.every(([, args]) => args[0] === 'volume')).toBe(true);
  });

  it('takes none when the version is known, or on a checkout build', async () => {
    deployed.mockResolvedValue({ kind: 'deployed', version: '0.32.0-rc.7', source: 'env-file' });
    expect(await backUpUnknownDockerVersion(fakeHost(), null, vi.fn())).toBeNull();

    deployed.mockResolvedValue({ kind: 'unreadable', reason: 'no SWITCH_VERSION entry' });
    expect(await backUpUnknownDockerVersion(fakeHost(), '/src/switch', vi.fn())).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('backUpUnknownVersion on a native server', () => {
  it('copies the data directory aside when deployed.json is gone beside it', async () => {
    const layout = nativeLayout(directory);
    await mkdir(layout.pgdata, { recursive: true });
    await writeFile(join(layout.pgdata, 'PG_VERSION'), '16\n');

    expect(await readNativeDeployedVersion(layout)).toMatchObject({ kind: 'unreadable' });
    const backup = await backUpUnknownVersion(null, vi.fn(), nativeUpgradeSource(layout));

    expect(backup).toMatch(/switch-core-unknown$/);
    expect(await readFile(join(backup!, 'pgdata', 'PG_VERSION'), 'utf8')).toBe('16\n');
    expect(await readFile(join(backup!, 'README.txt'), 'utf8')).toContain(
      'because nothing recorded which switch-core version last ran it'
    );
    // The record is the start's to write, once the backup is done.
    expect(await readNativeDeployedVersion(layout)).toMatchObject({ kind: 'unreadable' });
  });

  it('takes none on a fresh install, or when the record names a version', async () => {
    const layout = nativeLayout(directory);
    expect(await backUpUnknownVersion(null, vi.fn(), nativeUpgradeSource(layout))).toBeNull();

    await mkdir(layout.pgdata, { recursive: true });
    await writeFile(join(layout.pgdata, 'PG_VERSION'), '16\n');
    await mkdir(layout.run, { recursive: true });
    await writeFile(join(layout.run, 'deployed.json'), '{"version":"0.32.0-rc.7"}');
    expect(await backUpUnknownVersion(null, vi.fn(), nativeUpgradeSource(layout))).toBeNull();
  });
});
