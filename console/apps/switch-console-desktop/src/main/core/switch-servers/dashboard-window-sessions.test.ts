import { existsSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionData = vi.hoisted(() => ({ dir: '' }));
const clearStorageData = vi.hoisted(() => vi.fn(async (_partition: string) => {}));
const flushStore = vi.hoisted(() => vi.fn(async () => {}));
const fromPartition = vi.hoisted(() =>
  vi.fn((partition: string) => ({
    clearStorageData: () => clearStorageData(partition),
    cookies: { flushStore },
  }))
);
const removeDirectory = vi.hoisted(() => ({ refuse: null as Error | null }));
const dashboardWindowSessionsCleared = vi.hoisted(() => vi.fn());
const markDashboardWindowSessionsCleared = vi.hoisted(() => vi.fn());
const forgetDashboardWindowSessionsCleared = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'sessionData') throw new Error(`unexpected path ${name}`);
      return sessionData.dir;
    },
  },
  session: { fromPartition },
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (removeDirectory.refuse) throw removeDirectory.refuse;
      return actual.rm(...args);
    },
  };
});
vi.mock('./dashboard-window-marker', () => ({
  dashboardWindowSessionsCleared,
  forgetDashboardWindowSessionsCleared,
  markDashboardWindowSessionsCleared,
}));
vi.mock('@main/lib/logger', () => ({ log: { warn, info: vi.fn(), error: logError } }));

const { clearDashboardWindowSession, clearDashboardWindowSessions } =
  await import('./dashboard-window-sessions');

/** Directories as Electron names them: the partition without `persist:`,
 * lower-cased and percent-escaped. */
const CURRENT = 'switch-gateway%3Asrv-1';
const REMOVED = 'switch-gateway%3A3f2b8c1e-aaaa-4bbb-9ccc-0123456789ab';
const NOT_OURS = [
  'switch-mattermost%3Asrv-1',
  'switch-gateway-other%3Asrv-1',
  'switchdash-browser',
  'switch-gateway%ZZ',
];

async function partitions(...names: string[]): Promise<void> {
  for (const name of names) {
    await mkdir(join(sessionData.dir, 'Partitions', name), { recursive: true });
    await writeFile(join(sessionData.dir, 'Partitions', name, 'Cookies'), 'switch_auth=…');
  }
}

async function onDisk(): Promise<string[]> {
  return (await readdir(join(sessionData.dir, 'Partitions'))).sort();
}

beforeEach(async () => {
  vi.clearAllMocks();
  removeDirectory.refuse = null;
  sessionData.dir = await mkdtemp(join(tmpdir(), 'dashboard-window-sessions-'));
  dashboardWindowSessionsCleared.mockResolvedValue(false);
});

afterEach(async () => {
  removeDirectory.refuse = null;
  await rm(sessionData.dir, { recursive: true, force: true });
});

describe('clearing what the old dashboard windows kept', () => {
  it('clears every dashboard window partition on disk, a removed server’s too, then never again', async () => {
    await partitions(CURRENT, REMOVED, ...NOT_OURS);

    await clearDashboardWindowSessions();

    expect(fromPartition.mock.calls.map(([partition]) => partition).sort()).toEqual([
      'persist:switch-gateway:3f2b8c1e-aaaa-4bbb-9ccc-0123456789ab',
      'persist:switch-gateway:srv-1',
    ]);
    expect(clearStorageData).toHaveBeenCalledTimes(2);
    expect(flushStore).toHaveBeenCalledTimes(2);
    expect(await onDisk()).toEqual([...NOT_OURS].sort());
    expect(markDashboardWindowSessionsCleared).toHaveBeenCalledOnce();

    dashboardWindowSessionsCleared.mockResolvedValue(true);
    vi.clearAllMocks();
    await partitions(CURRENT);
    await clearDashboardWindowSessions();
    expect(fromPartition).not.toHaveBeenCalled();
  });

  it('marks the pass done when there are no partitions at all', async () => {
    await clearDashboardWindowSessions();

    expect(fromPartition).not.toHaveBeenCalled();
    expect(markDashboardWindowSessionsCleared).toHaveBeenCalledOnce();
  });

  it('says which could not be cleared, keeps it, and tries again next time', async () => {
    await partitions(CURRENT, REMOVED);
    clearStorageData.mockImplementation(async (partition) => {
      if (partition === 'persist:switch-gateway:srv-1') throw new Error('locked');
    });

    try {
      await clearDashboardWindowSessions();
    } finally {
      clearStorageData.mockImplementation(async () => {});
    }

    expect(warn).toHaveBeenCalledWith(
      'switch-servers: could not clear the session an old dashboard window kept',
      { partition: 'persist:switch-gateway:srv-1', error: 'Error: locked' }
    );
    expect(await onDisk()).toEqual([CURRENT]);
    expect(markDashboardWindowSessionsCleared).not.toHaveBeenCalled();
  });

  it('counts a partition cleared when only its emptied directory is left behind', async () => {
    await partitions(CURRENT);
    removeDirectory.refuse = Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });

    await clearDashboardWindowSessions();

    expect(clearStorageData).toHaveBeenCalledOnce();
    expect(flushStore).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'switch-servers: cleared an old dashboard window’s session but left its directory',
      { partition: 'persist:switch-gateway:srv-1', error: 'Error: EBUSY: resource busy' }
    );
    expect(markDashboardWindowSessionsCleared).toHaveBeenCalledOnce();
  });
});

describe('clearing a removed server’s dashboard window partition', () => {
  it('clears that server’s partition and no other', async () => {
    await partitions(CURRENT, REMOVED, ...NOT_OURS);

    await clearDashboardWindowSession('SRV-1');

    expect(fromPartition).toHaveBeenCalledExactlyOnceWith('persist:switch-gateway:srv-1');
    expect(clearStorageData).toHaveBeenCalledOnce();
    expect(await onDisk()).toEqual([REMOVED, ...NOT_OURS].sort());
  });

  it('lets the removal go on when clearing fails, and has the next launch try again', async () => {
    await partitions(CURRENT);
    clearStorageData.mockRejectedValueOnce(new Error('cookie store locked'));

    await expect(clearDashboardWindowSession('srv-1')).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledOnce();
    expect(forgetDashboardWindowSessionsCleared).toHaveBeenCalledOnce();
    expect(await onDisk()).toContain(CURRENT);
  });

  it('opens no session, so creates no partition, when the server never had one', async () => {
    await partitions(REMOVED);

    await clearDashboardWindowSession('srv-1');

    expect(fromPartition).not.toHaveBeenCalled();
    expect(existsSync(join(sessionData.dir, 'Partitions', CURRENT))).toBe(false);
  });
});
