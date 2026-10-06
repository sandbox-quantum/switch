import { describe, expect, it, vi } from 'vitest';

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

const { installKindFor, recordLaunch, reportLaunch } = await import('./launch-history');

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
  const inputs = async () => ({
    version: '2.0.0',
    channel: 'stable' as const,
    databaseExisted: false,
  });

  it('sends app_launched with the kind it recorded', async () => {
    h.trackEvent.mockClear();

    await reportLaunch(inputs);

    expect(h.trackEvent).toHaveBeenCalledWith('app_launched', {
      install_kind: expect.stringMatching(/^(new|updated|same)$/),
    });
  });

  it('never rejects when the launch cannot be recorded, so boot is not held up', async () => {
    // Boot starts this without waiting on it; a rejection would be unhandled,
    // and an awaited one would stop everything after it, the window included.
    h.trackEvent.mockClear();
    h.warn.mockClear();
    h.readFails = true;
    try {
      await expect(reportLaunch(inputs)).resolves.toBeUndefined();
    } finally {
      h.readFails = false;
    }

    expect(h.trackEvent).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not record this launch'),
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('never rejects when what it reads to record the launch fails', async () => {
    h.trackEvent.mockClear();

    await expect(
      reportLaunch(async () => {
        throw new Error('package.json unreadable');
      })
    ).resolves.toBeUndefined();

    expect(h.trackEvent).not.toHaveBeenCalled();
  });
});
