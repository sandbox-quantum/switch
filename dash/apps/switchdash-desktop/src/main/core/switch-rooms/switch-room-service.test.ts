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

vi.mock('@main/db/client', () => {
  const where = () => Promise.resolve([] as unknown[]);
  const from = () => ({ where });
  const onConflictDoUpdate = () => Promise.resolve(undefined);
  const values = () => ({ onConflictDoUpdate });
  return { db: { select: () => ({ from }), insert: () => ({ values }) } };
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
});
