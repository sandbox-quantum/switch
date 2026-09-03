import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionRoomChangedChannel } from '@shared/core/switch-rooms/switchRoomEvents';

const emit = vi.fn();

vi.mock('@main/lib/events', () => ({
  events: { emit: (...args: unknown[]) => emit(...args) },
}));

vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./switch-notification-poller', () => ({
  switchNotificationPoller: { connect: vi.fn(), disconnect: vi.fn(), dispose: vi.fn() },
}));

const dbInsert = vi.fn();
const dbDelete = vi.fn();
vi.mock('@main/db/client', () => {
  const where = () => Promise.resolve([] as unknown[]);
  const from = () => ({ where });
  const onConflictDoUpdate = () => Promise.resolve(undefined);
  const values = () => ({ onConflictDoUpdate });
  return {
    db: {
      select: () => ({ from }),
      insert: () => {
        dbInsert();
        return { values };
      },
      delete: () => {
        dbDelete();
        return { where: () => Promise.resolve(undefined) };
      },
    },
  };
});

const { switchRoomService } = await import('./switch-room-service');

const ctx = {
  sessionId: 'session-1',
  locationId: 'proj-1',
  providerId: 'claude',
  ptyId: 'claude-session-session-1',
};

describe('SwitchRoomService', () => {
  beforeEach(() => {
    switchRoomService.dispose();
    emit.mockClear();
    dbInsert.mockClear();
    dbDelete.mockClear();
  });

  it('records a connection and emits a change', () => {
    switchRoomService.setSessionRoom(ctx, 'room-a', 'agent-1', 'Room A');

    expect(switchRoomService.getConnections()).toEqual([
      { sessionId: 'session-1', roomId: 'room-a', agentId: 'agent-1' },
    ]);
    expect(emit).toHaveBeenCalledWith(sessionRoomChangedChannel, {
      sessionId: 'session-1',
      roomId: 'room-a',
      agentId: 'agent-1',
    });
  });

  it('does not re-emit when the same room/agent is reported again', () => {
    switchRoomService.setSessionRoom(ctx, 'room-a', 'agent-1', 'Room A');
    emit.mockClear();
    switchRoomService.setSessionRoom(ctx, 'room-a', 'agent-1', 'Room A');
    expect(emit).not.toHaveBeenCalled();
  });

  it('replaces the room when the session connects elsewhere', () => {
    switchRoomService.setSessionRoom(ctx, 'room-a', 'agent-1', 'Room A');
    switchRoomService.setSessionRoom(ctx, 'room-b', 'agent-1', 'Room B');

    expect(switchRoomService.getConnections()).toEqual([
      { sessionId: 'session-1', roomId: 'room-b', agentId: 'agent-1' },
    ]);
  });

  it('clears a connection and emits nulls', () => {
    switchRoomService.setSessionRoom(ctx, 'room-a', 'agent-1', 'Room A');
    emit.mockClear();
    switchRoomService.clearSession('session-1');

    expect(switchRoomService.getConnections()).toEqual([]);
    expect(emit).toHaveBeenCalledWith(sessionRoomChangedChannel, {
      sessionId: 'session-1',
      roomId: null,
      agentId: null,
    });
  });

  it('clearing an unknown session is a no-op (no event)', () => {
    switchRoomService.clearSession('nope');
    expect(emit).not.toHaveBeenCalled();
  });

  it('mirrors a remote session room for display and emits a change', () => {
    switchRoomService.mirrorRemoteSessionRoom(ctx, 'room-a', 'agent-1');

    expect(switchRoomService.getConnections()).toEqual([
      { sessionId: 'session-1', roomId: 'room-a', agentId: 'agent-1' },
    ]);
    expect(emit).toHaveBeenCalledWith(sessionRoomChangedChannel, {
      sessionId: 'session-1',
      roomId: 'room-a',
      agentId: 'agent-1',
    });
  });

  it('does not re-emit when mirroring the same room every tick', () => {
    switchRoomService.mirrorRemoteSessionRoom(ctx, 'room-a', 'agent-1');
    emit.mockClear();
    switchRoomService.mirrorRemoteSessionRoom(ctx, 'room-a', 'agent-1');
    expect(emit).not.toHaveBeenCalled();
  });

  it('re-emits when a mirrored session switches room', () => {
    switchRoomService.mirrorRemoteSessionRoom(ctx, 'room-a', 'agent-1');
    emit.mockClear();
    switchRoomService.mirrorRemoteSessionRoom(ctx, 'room-b', 'agent-1');
    expect(emit).toHaveBeenCalledWith(sessionRoomChangedChannel, {
      sessionId: 'session-1',
      roomId: 'room-b',
      agentId: 'agent-1',
    });
  });

  it('does not persist a mirrored remote room (no restore-blob write)', async () => {
    // The reconciler re-derives remote rooms from the live sidecar snapshot on
    // every boot, so a mirrored room must not enter the persisted restore set —
    // else restoreSwitchRoomSessions would try to relaunch it at next startup.
    switchRoomService.mirrorRemoteSessionRoom(ctx, 'room-a', 'agent-1');
    await Promise.resolve();
    await Promise.resolve();
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('setSessionRoom does persist (contrast with the mirror path)', async () => {
    switchRoomService.setSessionRoom(ctx, 'room-a', 'agent-1', 'Room A');
    await vi.waitFor(() => expect(dbInsert).toHaveBeenCalled());
  });

  it('drops the persisted room when the server refuses it', async () => {
    // The persisted row is what a restart re-declares. A room id outlives the
    // room it named, so leaving it there means the next launch opens a
    // connection the server refuses outright — for as long as the install
    // lives.
    switchRoomService.setSessionRoom(ctx, 'room-gone', 'agent-1', null);
    await switchRoomService.forgetRefusedRoom('session-1', 'room-gone');
    expect(dbDelete).toHaveBeenCalled();
  });

  it('a session ending does not drop its persisted room', async () => {
    // clearSession runs on every session exit, and the row is exactly what a
    // resumed session is restored from.
    switchRoomService.setSessionRoom(ctx, 'room-a', 'agent-1', null);
    switchRoomService.clearSession('session-1');
    expect(dbDelete).not.toHaveBeenCalled();
  });
});
