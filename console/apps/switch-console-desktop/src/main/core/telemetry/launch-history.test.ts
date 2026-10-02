import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/db/kv', () => ({ KV: class {} }));

const { installKindFor } = await import('./launch-history');

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
