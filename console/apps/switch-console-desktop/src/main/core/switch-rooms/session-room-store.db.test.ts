import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { agents, locations, sessionRoomConnections, sessions } from '@main/db/schema';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const {
  forgetRoomConnections,
  getPersistedRoomConnection,
  listPersistedRoomSessionIds,
  persistRoomConnection,
} = await import('./session-room-store');

describe('session-room-store', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;

    await fixture.db
      .insert(locations)
      .values({ id: 'loc-1', name: 'repo', sshHost: '', dir: '/tmp/repo' });
    await fixture.db
      .insert(agents)
      .values({ id: 'agent-1', locationId: 'loc-1', name: 'agent-one', providerId: 'claude' });
    await fixture.db
      .insert(sessions)
      .values({ id: 'session-1', agentId: 'agent-1', title: 'Session' });
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('round-trips a connection and upserts on a room switch', async () => {
    await persistRoomConnection('session-1', {
      roomId: 'room-1',
      roomName: 'First room',
      switchAgentId: 'switch-agent-1',
    });
    await expect(getPersistedRoomConnection('session-1')).resolves.toEqual({
      roomId: 'room-1',
      roomName: 'First room',
      switchAgentId: 'switch-agent-1',
    });

    await persistRoomConnection('session-1', {
      roomId: 'room-2',
      roomName: 'Second room',
      switchAgentId: 'switch-agent-1',
    });

    // A session holds at most one room, so the switch replaces rather than adds.
    await expect(listPersistedRoomSessionIds()).resolves.toEqual(['session-1']);
    await expect(getPersistedRoomConnection('session-1')).resolves.toMatchObject({
      roomId: 'room-2',
    });
  });

  it('returns null for a session that never connected', async () => {
    await expect(getPersistedRoomConnection('session-unknown')).resolves.toBeNull();
  });

  it('forgets the named sessions and leaves the rest', async () => {
    await fixture.db
      .insert(sessions)
      .values({ id: 'session-2', agentId: 'agent-1', title: 'Other' });
    await persistRoomConnection('session-1', {
      roomId: 'room-1',
      roomName: null,
      switchAgentId: null,
    });
    await persistRoomConnection('session-2', {
      roomId: 'room-2',
      roomName: null,
      switchAgentId: null,
    });

    await forgetRoomConnections(['session-1']);

    await expect(listPersistedRoomSessionIds()).resolves.toEqual(['session-2']);
  });

  it('does nothing when asked to forget nothing', async () => {
    await persistRoomConnection('session-1', {
      roomId: 'room-1',
      roomName: null,
      switchAgentId: null,
    });

    await forgetRoomConnections([]);

    await expect(listPersistedRoomSessionIds()).resolves.toEqual(['session-1']);
  });

  // The cascade is the reason this table exists: it is what makes a connection
  // that outlives its session — and so a poller hammering a server that no
  // longer exists — unrepresentable. It only holds if foreign keys are actually
  // enforced on the runtime connection, so assert the enforcement too.
  describe('foreign-key cascade', () => {
    it('enforces foreign keys on a connection opened the way the app opens one', () => {
      expect(fixture.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('drops the connection when its session is deleted', async () => {
      await persistRoomConnection('session-1', {
        roomId: 'room-1',
        roomName: null,
        switchAgentId: null,
      });

      await fixture.db.delete(sessions).where(eq(sessions.id, 'session-1'));

      await expect(listPersistedRoomSessionIds()).resolves.toEqual([]);
    });

    it('drops the connection when the agent above the session is deleted', async () => {
      await persistRoomConnection('session-1', {
        roomId: 'room-1',
        roomName: null,
        switchAgentId: null,
      });

      await fixture.db.delete(agents).where(eq(agents.id, 'agent-1'));

      await expect(listPersistedRoomSessionIds()).resolves.toEqual([]);
      await expect(fixture.db.select().from(sessionRoomConnections)).resolves.toEqual([]);
    });
  });
});
