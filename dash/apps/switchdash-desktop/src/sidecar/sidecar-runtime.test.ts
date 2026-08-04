import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawHookRequest } from '@main/core/agent-hooks/hook-server';
import type { RoomConnectionDeps } from '@main/core/switch-rooms/room-connection';
import { makePtyId } from '@shared/core/pty/ptyId';
import {
  type ManagedConnection,
  type RoomConnectionFactory,
  type SessionRegistry,
  SidecarRuntime,
} from './sidecar-runtime';
import type { SidecarSessionEntry } from './sidecar-state';

// Use the generic parser so raw 'start'/'stop' map to status deterministically,
// independent of any provider's custom hook parser.
vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: () => ({ behavior: { hooks: undefined }, capabilities: { prompt: { kind: 'argv' } } }),
}));

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function fakeConnection(): ManagedConnection {
  return { start: vi.fn(), stop: vi.fn(), onAgentStatusChange: vi.fn() };
}

function switchRoomHook(roomId: string, ptyId: string): RawHookRequest {
  return {
    ptyId,
    type: 'switch_room_connect',
    body: JSON.stringify({
      tool_response: { room_id: roomId, agent_id: 'agent-1', name: `Room ${roomId}` },
    }),
  } as RawHookRequest;
}

function statusHook(type: string, ptyId: string): RawHookRequest {
  return { ptyId, type, body: JSON.stringify({}) } as RawHookRequest;
}

/** In-memory stand-in for the durable state store. */
function fakeRegistry(): SessionRegistry & { entries: () => SidecarSessionEntry[] } {
  const sessions = new Map<string, SidecarSessionEntry>();
  return {
    has: (id) => sessions.has(id),
    record: (entry) => {
      const prev = sessions.get(entry.sessionId);
      sessions.set(entry.sessionId, { ...entry, roomId: entry.roomId ?? prev?.roomId ?? null });
    },
    forget: (id) => void sessions.delete(id),
    entries: () => [...sessions.values()],
  };
}

function makeRuntime() {
  const created: Array<{ deps: RoomConnectionDeps; conn: ManagedConnection }> = [];
  const factory: RoomConnectionFactory = (deps) => {
    const conn = fakeConnection();
    created.push({ deps, conn });
    return conn;
  };
  const registry = fakeRegistry();
  const runtime = new SidecarRuntime({
    creds: { agentId: 'agent-1', apiEndpoint: 'https://switch.test', token: 'tok' },
    locationId: 'proj-1',
    deeplinkScheme: 'switchdash',
    tmuxRun: vi.fn(),
    isPaneLive: () => true,
    log: silentLog,
    createConnection: factory,
    registry,
  });
  return { runtime, created, registry };
}

const PTY_A = makePtyId('codex', 'session-a');
const PTY_B = makePtyId('codex', 'session-b');

describe('SidecarRuntime (multi-session)', () => {
  beforeEach(() => {
    silentLog.warn.mockClear();
  });

  it('starts a tmux-backed room connection on a switch-room connect', async () => {
    const { runtime, created } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));

    expect(created).toHaveLength(1);
    expect(created[0].deps.roomId).toBe('room-1');
    expect(created[0].deps.sessionId).toBe('session-a');
    expect(created[0].conn.start).toHaveBeenCalledTimes(1);
  });

  // The receiving half of the watcher's hand-off. The watcher already consumed
  // the event that made it spawn, so the session's own connection has to rewind
  // to it — opened at head, the session misses the message it exists to answer.
  it('opens a spawned session at the cursor the watcher handed over', () => {
    const { runtime, created } = makeRuntime();

    runtime.ensureForSession('session-a', 'codex', 'room-1', 41);

    expect(created).toHaveLength(1);
    expect(created[0].deps.startCursor).toBe(41);
  });

  // A session is auto-started to answer a message in a room, so it opens
  // already claiming it. Waiting for the agent's own connect_to_room left it
  // room-less — sitting outside the room it was started for.
  it('opens a spawned session already claiming the room it was launched for', () => {
    const { runtime, created } = makeRuntime();

    runtime.ensureForSession('session-a', 'codex', 'room-1', 41);

    expect(created[0].deps.roomId).toBe('room-1');
  });

  it('opens a session at head when no cursor was handed over', () => {
    const { runtime, created } = makeRuntime();

    runtime.ensureForSession('session-a', 'codex', 'room-1');

    expect(created[0].deps.startCursor).toBeUndefined();
  });

  it('records every hooked session (hasSeen) so /sessions can scope tmux to this agent', async () => {
    const { runtime } = makeRuntime();
    expect(runtime.hasSeen('session-a')).toBe(false);
    // A plain status hook (no room connect) still marks the session as owned.
    await runtime.handleHook(statusHook('start', PTY_A));
    expect(runtime.hasSeen('session-a')).toBe(true);
    expect(runtime.hasSeen('session-b')).toBe(false);
  });

  it('serves two sessions concurrently, one connection each', async () => {
    const { runtime, created } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));
    await runtime.handleHook(switchRoomHook('room-2', PTY_B));

    expect(created).toHaveLength(2);
    // The first session's connection is NOT stopped by the second connecting.
    expect(created[0].conn.stop).not.toHaveBeenCalled();
    expect(created[1].deps.roomId).toBe('room-2');
  });

  it('supersedes only the same session when it re-targets to a new room', async () => {
    const { runtime, created } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));
    await runtime.handleHook(switchRoomHook('room-2', PTY_A));

    expect(created).toHaveLength(2);
    expect(created[0].conn.stop).toHaveBeenCalledTimes(1);
    expect(created[1].deps.roomId).toBe('room-2');
  });

  it('ignores a repeat connect to the same room by the same session', async () => {
    const { runtime, created } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));

    expect(created).toHaveLength(1);
  });

  it('routes a status change only to the session it came from', async () => {
    const { runtime, created } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));
    await runtime.handleHook(switchRoomHook('room-2', PTY_B));
    await runtime.handleHook(statusHook('start', PTY_A));

    expect(created[0].conn.onAgentStatusChange).toHaveBeenCalledWith('working', undefined);
    expect(created[1].conn.onAgentStatusChange).not.toHaveBeenCalled();
  });

  it('reports a room live only while its pane is up', async () => {
    const { runtime } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));
    expect(runtime.hasLiveRoom('room-1')).toBe(true);
    expect(runtime.hasLiveRoom('room-2')).toBe(false);
  });

  it('lists connected sessions (session id + room) for reconciliation, live panes only', async () => {
    const { runtime } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));
    await runtime.handleHook(switchRoomHook('room-2', PTY_B));

    expect(runtime.connectedSessions()).toEqual([
      { sessionId: 'session-a', roomId: 'room-1' },
      { sessionId: 'session-b', roomId: 'room-2' },
    ]);
  });

  it('omits a connected session whose pane has died from connectedSessions()', async () => {
    const created: Array<{ deps: RoomConnectionDeps; conn: ManagedConnection }> = [];
    const factory: RoomConnectionFactory = (deps) => {
      const conn = fakeConnection();
      created.push({ deps, conn });
      return conn;
    };
    let paneLive = true;
    const runtime = new SidecarRuntime({
      creds: { agentId: 'agent-1', apiEndpoint: 'https://switch.test', token: 'tok' },
      locationId: 'proj-1',
      deeplinkScheme: 'switchdash',
      tmuxRun: vi.fn(),
      isPaneLive: () => paneLive,
      log: silentLog,
      createConnection: factory,
      registry: fakeRegistry(),
    });
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));
    expect(runtime.connectedSessions()).toHaveLength(1);
    paneLive = false;
    expect(runtime.connectedSessions()).toEqual([]);
  });

  it('notifies the room-connected listener when a session connects to a room', async () => {
    const { runtime } = makeRuntime();
    const connected: string[] = [];
    runtime.onRoomConnected((roomId) => connected.push(roomId));

    await runtime.handleHook(switchRoomHook('room-1', PTY_A));

    expect(connected).toEqual(['room-1']);
  });

  it('notifies the listener again on a repeat connect (idempotent guard hand-off)', async () => {
    const { runtime } = makeRuntime();
    const connected: string[] = [];
    runtime.onRoomConnected((roomId) => connected.push(roomId));

    await runtime.handleHook(switchRoomHook('room-1', PTY_A));
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));

    expect(connected).toEqual(['room-1', 'room-1']);
  });

  // The spawner's launched entry is keyed by session, not room, so the listener
  // has to carry the session id — without it the entry cannot be dropped, and it
  // keeps vouching for the room the session was started for after it has moved.
  it('tells the listener which session connected, on first connect and on a move', async () => {
    const { runtime } = makeRuntime();
    const connected: Array<[string, string]> = [];
    runtime.onRoomConnected((roomId, sessionId) => connected.push([roomId, sessionId]));

    await runtime.handleHook(switchRoomHook('room-1', PTY_A));
    await runtime.handleHook(switchRoomHook('room-2', PTY_A));

    expect(connected).toEqual([
      ['room-1', 'session-a'],
      ['room-2', 'session-a'],
    ]);
  });

  it('roomIdForSession returns the attended room, or null when unknown', async () => {
    const { runtime } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));

    expect(runtime.roomIdForSession('session-a')).toBe('room-1');
    expect(runtime.roomIdForSession('session-unknown')).toBeNull();
  });

  it('stops all connections on stop()', async () => {
    const { runtime, created } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));
    runtime.stop();

    expect(created[0].conn.stop).toHaveBeenCalled();
  });

  it('stopSession stops and forgets only that session', async () => {
    const { runtime, created } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));
    await runtime.handleHook(switchRoomHook('room-2', PTY_B));

    runtime.stopSession('session-a');

    expect(created[0].conn.stop).toHaveBeenCalledTimes(1);
    expect(created[1].conn.stop).not.toHaveBeenCalled();
    // Forgotten: no longer reported and its room is no longer live.
    expect(runtime.connectedSessions()).toEqual([{ sessionId: 'session-b', roomId: 'room-2' }]);
    expect(runtime.hasLiveRoom('room-1')).toBe(false);
  });

  it('stopSession is a no-op for an unknown session', async () => {
    const { runtime, created } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));

    runtime.stopSession('session-unknown');

    expect(created[0].conn.stop).not.toHaveBeenCalled();
    expect(runtime.connectedSessions()).toHaveLength(1);
  });
});
