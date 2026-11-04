import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { kv } from '@main/db/schema';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

/**
 * The marker as one run of the app sees it. `take()` keeps its answer for the
 * whole run, so each launch is a fresh copy of the module.
 */
async function launch() {
  vi.resetModules();
  return (await import('./pending-install')).pendingInstall;
}

describe('the pending-install marker', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  let pendingInstall: Awaited<ReturnType<typeof launch>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    pendingInstall = await launch();
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('is empty on an ordinary launch', async () => {
    await expect(pendingInstall.take()).resolves.toBeNull();
  });

  it('returns the version handed over, and the one it replaces, once', async () => {
    await pendingInstall.set('1.3.0', '1.2.3');

    await expect(pendingInstall.take()).resolves.toEqual({
      targetVersion: '1.3.0',
      fromVersion: '1.2.3',
    });
    // The next launch finds nothing.
    await expect((await launch()).take()).resolves.toBeNull();
  });

  it('gives every caller in a run the same answer', async () => {
    // The update service and the launch report both ask. Whichever is second
    // must not read the record that the first one cleared.
    await pendingInstall.set('1.3.0', '1.2.3');

    const [first, second] = await Promise.all([pendingInstall.take(), pendingInstall.take()]);

    expect(first).toEqual({ targetVersion: '1.3.0', fromVersion: '1.2.3' });
    expect(second).toEqual(first);
  });

  it('is gone after an attempt is abandoned', async () => {
    await pendingInstall.set('1.3.0', '1.2.3');
    await pendingInstall.clear();

    await expect(pendingInstall.take()).resolves.toBeNull();
  });

  it('reads the marker a build without target versions wrote', async () => {
    // The first launch of this build follows an install handed over by the
    // build before it, which wrote only `true`.
    await fixture.db
      .insert(kv)
      .values({ key: 'updates:pending-install:handover', value: 'true', updatedAt: Date.now() });

    await expect(pendingInstall.take()).resolves.toEqual({
      targetVersion: null,
      fromVersion: null,
    });
    await expect((await launch()).take()).resolves.toBeNull();
  });

  it('reports the latest version when a second attempt overwrites the first', async () => {
    await pendingInstall.set('1.3.0', '1.2.3');
    await pendingInstall.set('1.4.0', '1.2.3');

    await expect(pendingInstall.take()).resolves.toEqual({
      targetVersion: '1.4.0',
      fromVersion: '1.2.3',
    });
  });

  it('prefers the version, and clears both, when both markers are present', async () => {
    await fixture.db
      .insert(kv)
      .values({ key: 'updates:pending-install:handover', value: 'true', updatedAt: Date.now() });
    await pendingInstall.set('1.3.0', '1.2.3');

    await expect(pendingInstall.take()).resolves.toEqual({
      targetVersion: '1.3.0',
      fromVersion: '1.2.3',
    });
    await expect((await launch()).take()).resolves.toBeNull();
  });

  it('clears the legacy marker too when an attempt is abandoned', async () => {
    await fixture.db
      .insert(kv)
      .values({ key: 'updates:pending-install:handover', value: 'true', updatedAt: Date.now() });
    await pendingInstall.clear();

    await expect(pendingInstall.take()).resolves.toBeNull();
  });

  it('fails loud when the marker cannot be written', async () => {
    // A handover with no marker could fail without anyone finding out, so the
    // caller has to hear about it.
    mocks.db = undefined;

    await expect(pendingInstall.set('1.3.0', '1.2.3')).rejects.toThrow();
  });
});
