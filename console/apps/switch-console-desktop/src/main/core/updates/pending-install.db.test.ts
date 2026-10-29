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

const { pendingInstall } = await import('./pending-install');

describe('the pending-install marker', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('is empty on an ordinary launch', async () => {
    await expect(pendingInstall.take()).resolves.toBeNull();
  });

  it('returns the version handed over, once', async () => {
    await pendingInstall.set('1.3.0');

    await expect(pendingInstall.take()).resolves.toEqual({ targetVersion: '1.3.0' });
    await expect(pendingInstall.take()).resolves.toBeNull();
  });

  it('is gone after an attempt is abandoned', async () => {
    await pendingInstall.set('1.3.0');
    await pendingInstall.clear();

    await expect(pendingInstall.take()).resolves.toBeNull();
  });

  it('reads the marker a build without target versions wrote', async () => {
    // The first launch of this build follows an install handed over by the
    // build before it, which wrote only `true`.
    await fixture.db
      .insert(kv)
      .values({ key: 'updates:pending-install:handover', value: 'true', updatedAt: Date.now() });

    await expect(pendingInstall.take()).resolves.toEqual({ targetVersion: null });
    await expect(pendingInstall.take()).resolves.toBeNull();
  });
});
