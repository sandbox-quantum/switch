import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const { ensureLocation, ensureObservedLocation, getLocationByHostDir, ObservedLocationError } =
  await import('./store');

/**
 * A location this Console only observes (CHOO-2893) and one it runs agents in
 * are different kinds of place, even at the same path: one is another
 * account's directory, the other this Console's. Neither may become the other.
 */
describe('observed locations', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('creates an observed location naming the account that runs it', async () => {
    const created = await ensureObservedLocation({
      sshHost: 'vm-1',
      dir: '/home/alice/reviewer',
      name: 'reviewer',
      owner: 'alice',
    });

    expect(created).toMatchObject({
      sshHost: 'vm-1',
      dir: '/home/alice/reviewer',
      observed: true,
      observedOwner: 'alice',
    });
    expect(await getLocationByHostDir('vm-1', '/home/alice/reviewer')).toEqual(created);
  });

  it('reuses the observed location for a second agent in the same directory', async () => {
    const first = await ensureObservedLocation({
      sshHost: 'vm-1',
      dir: '/home/alice/reviewer',
      name: 'reviewer',
      owner: 'alice',
    });
    const second = await ensureObservedLocation({
      sshHost: 'vm-1',
      dir: '/home/alice/reviewer',
      name: 'ignored',
      owner: null,
    });

    expect(second.id).toBe(first.id);
    expect(second.observedOwner).toBe('alice');
  });

  it('will not run agents at a place it only observes', async () => {
    await ensureObservedLocation({
      sshHost: 'vm-1',
      dir: '/home/alice/reviewer',
      name: 'reviewer',
      owner: 'alice',
    });

    const attempt = ensureLocation({ sshHost: 'vm-1', dir: '/home/alice/reviewer', name: 'x' });

    await expect(attempt).rejects.toBeInstanceOf(ObservedLocationError);
    await expect(attempt).rejects.toThrow(/belongs to the account alice/);
  });

  it('will not turn a place it runs agents in into one it only observes', async () => {
    await ensureLocation({ sshHost: 'vm-1', dir: '/home/bob/proj', name: 'proj' });

    await expect(
      ensureObservedLocation({ sshHost: 'vm-1', dir: '/home/bob/proj', name: 'proj', owner: null })
    ).rejects.toThrow(/already a location this Console runs agents in/);
  });

  it('leaves an ordinary location unobserved', async () => {
    expect(await ensureLocation({ sshHost: null, dir: '/work', name: 'work' })).toMatchObject({
      observed: false,
      observedOwner: null,
    });
  });
});
