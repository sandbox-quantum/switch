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
  COMPATIBLE_SWITCH_VERSION: '0.11.0',
}));
vi.mock('./deployed-version', async (importOriginal) => ({
  ...(await importOriginal<typeof DeployedVersion>()),
  readDeployedVersion: deployed,
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { finishUpgrade, owedUpgrade, prepareUpgrade, readUpgradeJournal, UPGRADE_JOURNAL_FILE } =
  await import('./managed-upgrade');

type Exec = (
  command: string,
  args: string[],
  opts?: unknown
) => Promise<{ stdout: string; stderr: string }>;

let directory: string;
let exec: ReturnType<typeof vi.fn<Exec>>;
let modes: Map<string, number>;

/** A host whose working dir is a temp directory and whose Docker is a fake
 * that writes a dump where `docker cp` is asked to put it. */
function fakeHost(kind: 'local' | 'remote'): ServerHost {
  return {
    kind,
    label: kind === 'local' ? 'this computer' : 'builder',
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
      await mkdir(dirname(join(directory, name)), { recursive: true });
      await writeFile(join(directory, name), value);
      if (mode !== undefined) modes.set(name, mode);
    },
    removeFile: async (name: string) => rm(join(directory, name), { force: true }),
    restrictMode: async (name: string, mode: number) => {
      modes.set(name, mode);
    },
  } as unknown as ServerHost;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'switch-upgrade-test-'));
  modes = new Map();
  exec = vi.fn<Exec>(async (_command, args) => {
    if (args.includes('ps')) return { stdout: 'abc123\n', stderr: '' };
    if (args[0] === 'cp') await writeFile(join(directory, args[2]), '-- PostgreSQL database dump');
    return { stdout: '', stderr: '' };
  });
  deployed.mockResolvedValue({ kind: 'deployed', version: '0.10.0', source: 'container' });
  const host = fakeHost('local');
  await host.writeFile('.env', 'SWITCH_VERSION=0.10.0\n');
  await host.writeFile('standalone-docker-compose.yml', 'services: {}\n');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('prepareUpgrade', () => {
  it.each(['local', 'remote'] as const)(
    'dumps the database and the old configuration before journalling the upgrade (%s host)',
    async (kind) => {
      const host = fakeHost(kind);
      const onUpgrade = vi.fn();
      const journal = await prepareUpgrade(host, null, vi.fn(), onUpgrade);

      expect(onUpgrade).toHaveBeenCalledWith({ from: '0.10.0', to: '0.11.0' });
      expect(journal).toMatchObject({ from: '0.10.0', to: '0.11.0' });
      expect(journal!.backup.startsWith(directory)).toBe(true);
      expect(JSON.parse((await host.readFile(UPGRADE_JOURNAL_FILE))!)).toEqual(journal);
      expect(await readFile(join(journal!.backup, 'database.sql'), 'utf8')).toContain('PostgreSQL');
      expect(await readFile(join(journal!.backup, '.env'), 'utf8')).toBe('SWITCH_VERSION=0.10.0\n');
      // The stack's own configuration is left for the start pipeline to rewrite.
      expect(await host.readFile('.env')).toBe('SWITCH_VERSION=0.10.0\n');

      const relative = journal!.backup.slice(directory.length + 1);
      expect(modes.get(relative)).toBe(0o700);
      expect(modes.get(`${relative}/database.sql`)).toBe(0o600);
      expect(modes.get(`${relative}/.env`)).toBe(0o600);

      const commands = exec.mock.calls.map(([, args]) => args);
      expect(commands[0]).toEqual(expect.arrayContaining(['up', '-d', '--no-deps', 'postgres']));
      expect(
        commands.some((args) => args[0] === 'exec' && args.join(' ').includes('pg_dumpall'))
      ).toBe(true);
      // The temporary dump is removed from the container afterwards.
      expect(commands.at(-1)).toEqual(expect.arrayContaining(['exec', 'abc123', 'rm', '-f']));
    }
  );

  it('does not journal an upgrade whose dump failed, and says why', async () => {
    const host = fakeHost('remote');
    exec.mockImplementation(async (_command, args) => {
      if (args.includes('ps')) return { stdout: 'abc123\n', stderr: '' };
      if (args[0] === 'exec' && args.join(' ').includes('pg_dumpall'))
        throw Object.assign(new Error('exit 1'), { stderr: 'pg_dumpall: No space left on device' });
      return { stdout: '', stderr: '' };
    });

    await expect(prepareUpgrade(host, null, vi.fn(), vi.fn())).rejects.toThrow(
      'No space left on device'
    );
    expect(await host.readFile(UPGRADE_JOURNAL_FILE)).toBeNull();
  });

  it('refuses to back up a stack whose configuration is missing', async () => {
    const host = fakeHost('local');
    await host.removeFile('standalone-docker-compose.yml');

    await expect(prepareUpgrade(host, null, vi.fn(), vi.fn())).rejects.toThrow(
      'standalone-docker-compose.yml is missing'
    );
    expect(exec).not.toHaveBeenCalled();
    expect(await host.readFile(UPGRADE_JOURNAL_FILE)).toBeNull();
  });

  it('resumes an interrupted upgrade without a second backup', async () => {
    const host = fakeHost('local');
    const first = await prepareUpgrade(host, null, vi.fn(), vi.fn());
    exec.mockClear();
    // By now the stack may already run the new version, half-migrated.
    deployed.mockResolvedValue({ kind: 'deployed', version: '0.11.0', source: 'container' });
    const onUpgrade = vi.fn();

    expect(await prepareUpgrade(host, null, vi.fn(), onUpgrade)).toEqual(first);
    expect(onUpgrade).toHaveBeenCalledWith({ from: '0.10.0', to: '0.11.0' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('carries an interrupted upgrade from an older app on to this pin', async () => {
    const host = fakeHost('local');
    await host.writeFile(
      UPGRADE_JOURNAL_FILE,
      JSON.stringify({ from: '0.9.0', to: '0.10.0', backup: '/backups/older' })
    );

    expect(await prepareUpgrade(host, null, vi.fn(), vi.fn())).toEqual({
      from: '0.9.0',
      to: '0.11.0',
      backup: '/backups/older',
    });
    expect(JSON.parse((await host.readFile(UPGRADE_JOURNAL_FILE))!).to).toBe('0.11.0');
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses an interrupted upgrade only a newer app can finish', async () => {
    const host = fakeHost('local');
    await host.writeFile(
      UPGRADE_JOURNAL_FILE,
      JSON.stringify({ from: '0.11.0', to: '0.12.0', backup: '/backups/newer' })
    );

    await expect(prepareUpgrade(host, null, vi.fn(), vi.fn())).rejects.toThrow(
      /switch-core 0\.12\.0 or newer.*\/backups\/newer/
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing deployed yet', { kind: 'absent' }],
    ['an unreadable version', { kind: 'unreadable', reason: 'daemon down' }],
    ['the same version', { kind: 'deployed', version: '0.11.0', source: 'container' }],
    ['a newer version', { kind: 'deployed', version: '0.12.0', source: 'container' }],
    ['an uncomparable version', { kind: 'deployed', version: 'nightly', source: 'env-file' }],
    ['a checkout build', { kind: 'deployed', version: 'dev-checkout', source: 'container' }],
  ])('is not an upgrade for %s', async (_label, version) => {
    deployed.mockResolvedValue(version);
    const onUpgrade = vi.fn();

    expect(await prepareUpgrade(fakeHost('local'), null, vi.fn(), onUpgrade)).toBeNull();
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('does not back up when building from a checkout', async () => {
    expect(await prepareUpgrade(fakeHost('local'), '/src/switch', vi.fn(), vi.fn())).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('the upgrade journal', () => {
  it('is gone once the upgrade finishes; the backup stays', async () => {
    const host = fakeHost('local');
    const journal = await prepareUpgrade(host, null, vi.fn(), vi.fn());
    await finishUpgrade(host);

    expect(await readUpgradeJournal(host)).toBeNull();
    expect(await readFile(join(journal!.backup, 'database.sql'), 'utf8')).toContain('PostgreSQL');
  });

  it('fails loudly when it cannot be read', async () => {
    const host = fakeHost('remote');
    await host.writeFile(UPGRADE_JOURNAL_FILE, '{"from": "0.10.0", "to"');

    await expect(readUpgradeJournal(host)).rejects.toThrow(/interrupted.*cannot be read/);
  });

  it('names the upgrade a stack owes', () => {
    const drift = { deployed: '0.10.0', expected: '0.11.0', direction: 'upgrade' } as const;
    expect(owedUpgrade(drift, null)).toEqual({ from: '0.10.0', to: '0.11.0' });
    expect(owedUpgrade(null, { from: '0.9.0', to: '0.10.0', backup: '/b' })).toEqual({
      from: '0.9.0',
      to: '0.11.0',
    });
    expect(
      owedUpgrade({ deployed: '0.12.0', expected: '0.11.0', direction: 'downgrade' }, null)
    ).toBeNull();
    expect(owedUpgrade(null, null)).toBeNull();
  });
});
