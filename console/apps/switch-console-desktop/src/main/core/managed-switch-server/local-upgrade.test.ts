import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as DeployedVersion from './deployed-version';
import type { ServerHost } from './host/types';
const deployed = vi.hoisted(() => vi.fn());
vi.mock('./deployed-version', async (original) => ({
  ...(await original<typeof DeployedVersion>()),
  readDeployedVersion: deployed,
}));
vi.mock('./host/local-host', () => ({ restrictWindowsFileToOwner: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
const { prepareLocalUpgrade, hasPendingLocalUpgrade, finishLocalUpgrade } =
  await import('./local-upgrade');
const { COMPATIBLE_SWITCH_VERSION: expected } = await import('@shared/app-identity');
let directory: string;
let exec: ReturnType<typeof vi.fn>;
let host: ServerHost;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'switch-upgrade-test-'));
  exec = vi.fn(async (_command: string, args: string[]) => {
    if (args.includes('ps')) return { stdout: 'abc123\n', stderr: '' };
    if (args[0] === 'cp') await writeFile(args[2], '-- PostgreSQL test dump');
    return { stdout: '', stderr: '' };
  });
  host = {
    kind: 'local',
    workingDir: directory,
    composeProjectName: 'test-stack',
    dockerBin: 'docker',
    ctx: { exec },
    readFile: async (name: string) =>
      readFile(join(directory, name), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
    writeFile: async (name: string, value: string, mode?: number) => {
      await mkdir(join(directory, name, '..'), { recursive: true });
      await writeFile(join(directory, name), value, { mode });
    },
  } as unknown as ServerHost;
  await host.writeFile('.env', 'SWITCH_VERSION=0.1.0');
  await host.writeFile('standalone-docker-compose.yml', 'services: {}');
  deployed.mockResolvedValue({ kind: 'deployed', version: '0.1.0', source: 'container' });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
it('retains the old configuration and database before recording a recoverable upgrade', async () => {
  await prepareLocalUpgrade(host, null, vi.fn());
  const journal = JSON.parse((await host.readFile('upgrade.json'))!);
  expect(journal).toMatchObject({ from: '0.1.0', to: expected });
  expect(await readFile(join(journal.backup, 'database.sql'), 'utf8')).toContain('PostgreSQL');
  expect(await readFile(join(journal.backup, '.env'), 'utf8')).toBe('SWITCH_VERSION=0.1.0');
  expect(await host.readFile('.env')).toBe('SWITCH_VERSION=0.1.0');
  expect(await hasPendingLocalUpgrade(host)).toBe(true);
  exec.mockClear();
  await prepareLocalUpgrade(host, null, vi.fn());
  expect(exec).not.toHaveBeenCalled();
  await finishLocalUpgrade(host);
  expect(await hasPendingLocalUpgrade(host)).toBe(false);
  expect(await readFile(join(journal.backup, 'database.sql'), 'utf8')).toContain('PostgreSQL');
});
it('does not record success when the database dump fails', async () => {
  exec.mockRejectedValue(new Error('Dump failed'));
  await expect(prepareLocalUpgrade(host, null, vi.fn())).rejects.toThrow('Dump failed');
  expect(await hasPendingLocalUpgrade(host)).toBe(false);
  expect(await host.readFile('.env')).toBe('SWITCH_VERSION=0.1.0');
});
it('refuses an interrupted upgrade from a newer app', async () => {
  await host.writeFile(
    'upgrade.json',
    JSON.stringify({ from: expected, to: '99.0.0', backup: '/backup' })
  );
  await expect(prepareLocalUpgrade(host, null, vi.fn())).rejects.toThrow('newer app');
  expect(exec).not.toHaveBeenCalled();
});
it('refuses missing, malformed and uncomparable evidence without mutating the deployment', async () => {
  for (const version of [
    { kind: 'unreadable', reason: 'denied' },
    { kind: 'deployed', version: 'nightly' },
    { kind: 'deployed', version: '99.0.0' },
  ]) {
    deployed.mockResolvedValue(version);
    await expect(prepareLocalUpgrade(host, null, vi.fn())).rejects.toThrow();
  }
  expect(exec).not.toHaveBeenCalled();
});

it('prepares a truly absent working directory before probing the installation', async () => {
  await rm(directory, { recursive: true, force: true });
  const actual = await vi.importActual<typeof DeployedVersion>('./deployed-version');
  deployed.mockImplementation(actual.readDeployedVersion);
  exec.mockImplementation(async () =>
    promisify(execFile)(process.execPath, ['-e', 'process.stdout.write("")'], { cwd: directory })
  );
  await prepareLocalUpgrade(host, null, vi.fn());
  expect(exec).toHaveBeenCalled();
  expect(await hasPendingLocalUpgrade(host)).toBe(false);
  expect(await host.readFile('.env')).toBeNull();
});
