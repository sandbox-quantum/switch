import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LaunchHistory from './launch-history';

const h = vi.hoisted(() => ({
  trackEvent: vi.fn(),
  warn: vi.fn(),
  readFails: false,
  isCanary: false,
  databaseExisted: true,
  handedOver: false,
  handoverFails: false,
}));

vi.mock('./telemetry-service', () => ({ trackEvent: h.trackEvent }));
vi.mock('@main/core/app/utils', () => ({ resolveAppVersion: async () => '2.3.0' }));
vi.mock('@shared/app-identity', () => ({
  get IS_CANARY() {
    return h.isCanary;
  },
}));
vi.mock('@main/db/client', () => ({
  get databaseExistedAtStart() {
    return h.databaseExisted;
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: h.warn } }));
vi.mock('@main/core/updates/pending-install', () => ({
  pendingInstall: {
    take: async () => {
      if (h.handoverFails) throw new Error('SQLITE_BUSY: database is locked');
      return h.handedOver;
    },
  },
}));
vi.mock('@main/db/kv', () => ({
  KV: class {
    private values = new Map<string, unknown>();
    async get(key: string) {
      if (h.readFails) throw new Error('SQLITE_BUSY: database is locked');
      return this.values.get(key) ?? null;
    }
    async set(key: string, value: unknown) {
      this.values.set(key, structuredClone(value));
    }
  },
}));

const { installKindFor, recordLaunch } = await import('./launch-history');

describe('which kind of launch this is', () => {
  const kindOf = (
    lastVersion: string | null,
    version: string,
    { databaseExisted = true, otherChannelLaunched = false } = {}
  ) => installKindFor({ lastVersion, version, databaseExisted, otherChannelLaunched });

  it('is new on an installation’s very first launch, so counting it counts installs', () => {
    expect(kindOf(null, '1.2.0', { databaseExisted: false })).toBe('new');
  });

  it('is an upgrade on the first launch at a newer version', () => {
    expect(kindOf('1.1.0', '1.2.0')).toBe('updated');
    expect(kindOf('1.2.0-canary.2', '1.2.0-canary.10')).toBe('updated');
  });

  it('is the same on a relaunch', () => {
    expect(kindOf('1.2.0', '1.2.0')).toBe('same');
  });

  it('is not an upgrade when an older version is reinstalled', () => {
    expect(kindOf('1.2.0', '1.1.4')).toBe('same');
    expect(kindOf('1.2.0-canary.3', '1.2.0-canary.2')).toBe('same');
  });

  it('is an upgrade, never new, for an installation that predates this tracking', () => {
    // It has a database but no record: it was installed at some earlier version,
    // and this is its first launch at one that records.
    expect(kindOf(null, '1.2.0')).toBe('updated');
  });

  it('is not an upgrade on the first launch of the other channel', () => {
    // The other channel's record says the installation has run before, so this
    // is a switch between canary and stable rather than an update.
    expect(kindOf(null, '1.3.0-canary.1', { otherChannelLaunched: true })).toBe('same');
  });
});

describe('canary and stable, which share one database', () => {
  it('do not read a switch between them as an upgrade', async () => {
    const launch = async (channel: 'canary' | 'stable', version: string) =>
      (await recordLaunch({ version, channel, databaseExisted: true })).kind;

    expect(await launch('stable', '1.4.0')).toBe('updated');
    expect(await launch('canary', '1.5.0-canary.2')).toBe('same');
    expect(await launch('stable', '1.4.0')).toBe('same');
    expect(await launch('canary', '1.5.0-canary.2')).toBe('same');
    expect(await launch('canary', '1.5.0-canary.3')).toBe('updated');
  });
});

describe('reporting a launch at boot', () => {
  // A fresh module per test: the launch record and this launch's kind are
  // module state, and one test's launch would otherwise be the next one's last.
  let launches: typeof LaunchHistory;

  beforeEach(async () => {
    vi.resetModules();
    h.trackEvent.mockClear();
    h.warn.mockClear();
    h.readFails = false;
    h.handedOver = false;
    h.handoverFails = false;
    launches = await import('./launch-history');
  });

  const firstLaunch = async () => ({
    version: '2.0.0',
    channel: 'stable' as const,
    databaseExisted: false,
  });

  it('sends app_launched with the kind it recorded', async () => {
    await launches.reportLaunch(firstLaunch);
    await launches.reportLaunch(firstLaunch);

    expect(h.trackEvent.mock.calls).toEqual([
      ['app_launched', { install_kind: 'new', from_version: 'none', update_trigger: 'none' }],
      ['app_launched', { install_kind: 'same', from_version: 'none', update_trigger: 'none' }],
    ]);
  });

  const launchAt = (version: string) => async () => ({
    version,
    channel: 'stable' as const,
    databaseExisted: true,
  });

  it('reports an upgrade with the version it came from, in the one launch event', async () => {
    h.handedOver = true;

    await launches.reportLaunch(launchAt('0.40.1'));
    await launches.reportLaunch(launchAt('0.41.0'));

    expect(h.trackEvent.mock.calls).toEqual([
      // A database with no launch record predates the tracking: an upgrade from
      // a version nobody wrote down.
      [
        'app_launched',
        { install_kind: 'updated', from_version: 'unknown', update_trigger: 'restart_button' },
      ],
      [
        'app_launched',
        { install_kind: 'updated', from_version: '0.40.1', update_trigger: 'restart_button' },
      ],
    ]);
  });

  it('says other for an update nobody pressed Restart for', async () => {
    await launches.reportLaunch(launchAt('0.40.1'));
    h.trackEvent.mockClear();

    await launches.reportLaunch(launchAt('0.41.0'));

    expect(h.trackEvent.mock.calls).toEqual([
      [
        'app_launched',
        { install_kind: 'updated', from_version: '0.40.1', update_trigger: 'other' },
      ],
    ]);
  });

  it('says unknown, and still reports the launch, when how it was installed cannot be read', async () => {
    await launches.reportLaunch(launchAt('0.40.1'));
    h.trackEvent.mockClear();
    h.handoverFails = true;

    await launches.reportLaunch(launchAt('0.41.0'));

    expect(h.trackEvent.mock.calls).toEqual([
      [
        'app_launched',
        { install_kind: 'updated', from_version: '0.40.1', update_trigger: 'unknown' },
      ],
    ]);
  });

  it('reports no update on a downgrade', async () => {
    h.handedOver = true;
    await launches.reportLaunch(launchAt('0.41.0'));
    h.trackEvent.mockClear();

    await launches.reportLaunch(launchAt('0.40.1'));

    expect(h.trackEvent.mock.calls).toEqual([
      ['app_launched', { install_kind: 'same', from_version: 'none', update_trigger: 'none' }],
    ]);
  });

  it('never rejects when the launch cannot be recorded, so boot is not held up', async () => {
    // Boot starts this without waiting on it; a rejection would be unhandled,
    // and an awaited one would stop everything after it, the window included.
    h.readFails = true;

    await expect(launches.reportLaunch(firstLaunch)).resolves.toBeUndefined();

    expect(h.trackEvent).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not record this launch'),
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('never rejects when what it reads to record the launch fails', async () => {
    await expect(
      launches.reportLaunch(async () => {
        throw new Error('package.json unreadable');
      })
    ).resolves.toBeUndefined();

    expect(h.trackEvent).not.toHaveBeenCalled();
  });
});

describe('asking for this launch’s kind', () => {
  let launches: typeof LaunchHistory;

  beforeEach(async () => {
    vi.resetModules();
    h.warn.mockClear();
    h.readFails = false;
    h.handedOver = false;
    launches = await import('./launch-history');
  });

  it('is the kind boot recorded', async () => {
    await launches.reportLaunch(async () => ({
      version: '2.0.0',
      channel: 'stable',
      databaseExisted: false,
    }));

    expect(await launches.launchInstallKind()).toBe('new');
  });

  it('waits for a recording boot started but has not finished', async () => {
    // Boot does not wait for the recording, so the first-run notice can be
    // answered while it is still reading the database.
    let read: (inputs: {
      version: string;
      channel: 'stable';
      databaseExisted: boolean;
    }) => void = () => {};
    void launches.reportLaunch(() => new Promise((resolve) => (read = resolve)));

    const asked = launches.launchInstallKind();
    read({ version: '2.0.0', channel: 'stable', databaseExisted: true });

    expect(await asked).toBe('updated');
  });

  it('is unknown, never a guessed kind, when the launch could not be recorded', async () => {
    h.readFails = true;
    await launches.reportLaunch(async () => ({
      version: '2.0.0',
      channel: 'stable',
      databaseExisted: false,
    }));

    expect(await launches.launchInstallKind()).toBe('unknown');
  });

  it('is unknown, and says so, when nothing recorded this launch', async () => {
    expect(await launches.launchInstallKind()).toBe('unknown');
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('nothing has recorded this launch')
    );
  });
});

describe('what boot records the launch from', () => {
  let launches: typeof LaunchHistory;

  beforeEach(() => {
    vi.resetModules();
    h.trackEvent.mockClear();
    h.readFails = false;
  });

  const load = async ({
    isCanary,
    databaseExisted,
  }: {
    isCanary: boolean;
    databaseExisted: boolean;
  }) => {
    h.isCanary = isCanary;
    h.databaseExisted = databaseExisted;
    launches = await import('./launch-history');
  };

  it('is the app version, the stable channel, and whether the database was already there', async () => {
    await load({ isCanary: false, databaseExisted: true });

    expect(await launches.readThisLaunch()).toEqual({
      version: '2.3.0',
      channel: 'stable',
      databaseExisted: true,
    });
  });

  it('is the canary channel in a canary build, so the two keep separate records', async () => {
    await load({ isCanary: true, databaseExisted: false });

    expect(await launches.readThisLaunch()).toEqual({
      version: '2.3.0',
      channel: 'canary',
      databaseExisted: false,
    });
  });

  it('reports a fresh install as new', async () => {
    await load({ isCanary: false, databaseExisted: false });

    await launches.reportLaunch(launches.readThisLaunch);

    expect(h.trackEvent).toHaveBeenCalledWith('app_launched', {
      install_kind: 'new',
      from_version: 'none',
      update_trigger: 'none',
    });
  });

  it('is started by boot without being waited on', () => {
    // Boot has no tests of its own, so this reads it. Waiting on the launch
    // would put a database read and write in front of the window opening.
    const boot = readFileSync(join(import.meta.dirname, '..', '..', 'index.ts'), 'utf8');

    expect(boot).toContain('void reportLaunch(readThisLaunch);');
    expect(boot).not.toMatch(/await\s+reportLaunch\b/);
  });
});
