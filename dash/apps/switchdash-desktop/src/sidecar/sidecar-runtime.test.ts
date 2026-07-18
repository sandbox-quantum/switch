import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawHookRequest } from '@main/core/agent-hooks/hook-server';
import type { RoomConnectionDeps } from '@main/core/switch-rooms/room-connection';
import { makePtyId } from '@shared/core/pty/ptyId';
import {
  type ManagedConnection,
  type RoomConnectionFactory,
  SidecarRuntime,
} from './sidecar-runtime';

// Use the generic parser so raw 'start'/'stop' map to status deterministically,
// independent of any provider's custom hook parser.
vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: () => ({ behavior: { hooks: undefined }, capabilities: { prompt: { kind: 'argv' } } }),
}));

const silentLog = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

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

function makeRuntime() {
  const created: Array<{ deps: RoomConnectionDeps; conn: ManagedConnection }> = [];
  const factory: RoomConnectionFactory = (deps) => {
    const conn = fakeConnection();
    created.push({ deps, conn });
    return conn;
  };
  const runtime = new SidecarRuntime({
    creds: { agentId: 'agent-1', apiEndpoint: 'https://switch.test', token: 'tok' },
    projectId: 'proj-1',
    deeplinkScheme: 'switchdash',
    tmuxRun: vi.fn(),
    isPaneLive: () => true,
    log: silentLog,
    createConnection: factory,
  });
  return { runtime, created };
}

const PTY_A = makePtyId('codex', 'conv-a');
const PTY_B = makePtyId('codex', 'conv-b');

describe('SidecarRuntime (multi-session)', () => {
  beforeEach(() => {
    silentLog.warn.mockClear();
  });

  it('starts a tmux-backed room connection on a switch-room connect', async () => {
    const { runtime, created } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));

    expect(created).toHaveLength(1);
    expect(created[0].deps.roomId).toBe('room-1');
    expect(created[0].deps.sessionId).toBe('conv-a');
    expect(created[0].conn.start).toHaveBeenCalledTimes(1);
  });

  it('records every hooked session (hasSeen) so /sessions can scope tmux to this agent', async () => {
    const { runtime } = makeRuntime();
    expect(runtime.hasSeen('conv-a')).toBe(false);
    // A plain status hook (no room connect) still marks the session as owned.
    await runtime.handleHook(statusHook('start', PTY_A));
    expect(runtime.hasSeen('conv-a')).toBe(true);
    expect(runtime.hasSeen('conv-b')).toBe(false);
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

  it('lists connected sessions (conversation id + room) for reconciliation, live panes only', async () => {
    const { runtime } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));
    await runtime.handleHook(switchRoomHook('room-2', PTY_B));

    expect(runtime.connectedSessions()).toEqual([
      { sessionId: 'conv-a', roomId: 'room-1' },
      { sessionId: 'conv-b', roomId: 'room-2' },
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
      projectId: 'proj-1',
      deeplinkScheme: 'switchdash',
      tmuxRun: vi.fn(),
      isPaneLive: () => paneLive,
      log: silentLog,
      createConnection: factory,
    });
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));
    expect(runtime.connectedSessions()).toHaveLength(1);
    paneLive = false;
    expect(runtime.connectedSessions()).toEqual([]);
  });

  it('stops all connections on stop()', async () => {
    const { runtime, created } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));
    runtime.stop();

    expect(created[0].conn.stop).toHaveBeenCalled();
  });

  it('stopSession stops and forgets only that conversation', async () => {
    const { runtime, created } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));
    await runtime.handleHook(switchRoomHook('room-2', PTY_B));

    runtime.stopSession('conv-a');

    expect(created[0].conn.stop).toHaveBeenCalledTimes(1);
    expect(created[1].conn.stop).not.toHaveBeenCalled();
    // Forgotten: no longer reported and its room is no longer live.
    expect(runtime.connectedSessions()).toEqual([{ sessionId: 'conv-b', roomId: 'room-2' }]);
    expect(runtime.hasLiveRoom('room-1')).toBe(false);
  });

  it('stopSession is a no-op for an unknown conversation', async () => {
    const { runtime, created } = makeRuntime();
    await runtime.handleHook(switchRoomHook('room-1', PTY_A));

    runtime.stopSession('conv-unknown');

    expect(created[0].conn.stop).not.toHaveBeenCalled();
    expect(runtime.connectedSessions()).toHaveLength(1);
  });
});
