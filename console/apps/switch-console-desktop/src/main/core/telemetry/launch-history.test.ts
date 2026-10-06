import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LaunchHistory from './launch-history';

const h = vi.hoisted(() => ({
  trackEvent: vi.fn(),
  warn: vi.fn(),
  readFails: false,
}));

vi.mock('./telemetry-service', () => ({ trackEvent: h.trackEvent }));
vi.mock('@main/lib/logger', () => ({ log: { warn: h.warn } }));
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
  it('is new on an installation’s very first launch, so counting it counts installs', () => {
    expect(installKindFor({ lastVersion: null, version: '1.2.0', databaseExisted: false })).toBe(
      'new'
    );
  });

  it('is an upgrade on the first launch at a different version', () => {
    expect(installKindFor({ lastVersion: '1.1.0', version: '1.2.0', databaseExisted: true })).toBe(
      'updated'
    );
  });

  it('is the same on a relaunch', () => {
    expect(installKindFor({ lastVersion: '1.2.0', version: '1.2.0', databaseExisted: true })).toBe(
      'same'
    );
  });

  it('is an upgrade, never new, for an installation that predates this tracking', () => {
    // It has a database but no record: it was installed at some earlier version,
    // and this is its first launch at one that records.
    expect(installKindFor({ lastVersion: null, version: '1.2.0', databaseExisted: true })).toBe(
      'updated'
    );
  });
});

describe('canary and stable, which share one database', () => {
  it('do not read a switch between them as an upgrade', async () => {
    const launch = (channel: 'canary' | 'stable', version: string) =>
      recordLaunch({ version, channel, databaseExisted: true });

    expect(await launch('stable', '1.4.0')).toBe('updated');
    expect(await launch('canary', '1.5.0-canary.2')).toBe('updated');
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
      ['app_launched', { install_kind: 'new' }],
      ['app_launched', { install_kind: 'same' }],
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
