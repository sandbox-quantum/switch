import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/db/kv', () => ({
  KV: class {
    private values = new Map<string, unknown>();
    async get(key: string) {
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
