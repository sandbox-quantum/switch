import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type * as LaunchModule from './launch';
import {
  RESIDENT_STOP_TIMEOUT_MS,
  ResidentSessions,
  ResidentTeardownError,
  assertSessionEnvironment,
  hostEnvironmentBaseline,
  roomSessionContext,
  streamAdmissionLog,
  type RoomSessionContext,
  type RoomSessionRun,
} from './resident-host';
import { sharedConfigSchema, type SharedHostConfig } from './shared-config';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('./launch', async (importOriginal) => ({
  // Only the state-directory location is redirected; ownership is the real thing.
  ...(await importOriginal<typeof LaunchModule>()),
  sharedSessionRoot: (id: string) => join(paths.root, id),
  ensureSharedProcess: vi.fn(),
}));

const roots: string[] = [];
afterEach(async () => {
  delegated.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'resident-host-test-'));
  roots.push(root);
  paths.root = root;
  return root;
}

/** Codex by default: its descendants can be fenced, so it runs in the host. */
function configFor(input: {
  cwd: string;
  roomId: string;
  sessionId: string;
  connectionId: string;
  provider?: 'codex' | 'claude';
}): SharedHostConfig {
  const provider = input.provider ?? 'codex';
  return sharedConfigSchema.parse({
    session: {
      sessionId: input.sessionId,
      agentId: 'agent',
      hostId: 'host',
      epoch: randomUUID(),
      provider,
      status: 'starting',
      connectivity: 'online',
      pendingRequestIds: [],
      capabilities: {
        input: 'queue',
        approvals: true,
        questions: true,
        interrupt: true,
        reset: false,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      },
    },
    start: {
      provider,
      input: {
        sessionId: input.sessionId,
        cwd: input.cwd,
        runtimeMode: 'approval-required',
        env: {
          SWITCH_CONNECTION_ID: input.connectionId,
          SWITCHDASH_SESSION_ID: input.sessionId,
          SWITCH_BOUND_ROOM_ID: input.roomId,
        },
        mcpServers: {},
      },
    },
    roomConnection: { connectionId: input.connectionId, rooms: [input.roomId], startCursor: 0 },
  });
}

const delegated: { roomId: string; sessionId: string }[] = [];
function hostFor(root: string, run: RoomSessionRun, stopTimeoutMs = RESIDENT_STOP_TIMEOUT_MS) {
  return new ResidentSessions(root, run, stopTimeoutMs, async (roomId, config) => {
    delegated.push({ roomId, sessionId: config.session.sessionId });
  });
}

/** A runner that stands in for a room session: it runs until its own signal aborts. */
function recordingRunner() {
  const started: RoomSessionContext[] = [];
  const finished: RoomSessionContext[] = [];
  const envs = new Map<string, Record<string, string>>();
  const faults = new Map<string, Error>();
  const run: RoomSessionRun = async ({ context, config, signal }) => {
    started.push(context);
    envs.set(context.sessionId, config.start.input.env);
    const fault = faults.get(context.sessionId);
    if (fault) throw fault;
    try {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    } finally {
      finished.push(context);
    }
  };
  return { run, started, finished, envs, faults };
}

it('dispatches two rooms into one host as two isolated sessions', async () => {
  const root = await workspace();
  const runner = recordingRunner();
  const host = hostFor(root, runner.run);
  const first = configFor({
    cwd: root,
    roomId: 'room-a',
    sessionId: 'session-a',
    connectionId: 'connection-a',
  });
  const second = configFor({
    cwd: root,
    roomId: 'room-b',
    sessionId: 'session-b',
    connectionId: 'connection-b',
  });
  await host.dispatch('room-a', first);
  await host.dispatch('room-b', second);

  expect(host.live()).toEqual([
    { roomId: 'room-a', sessionId: 'session-a', connectionId: 'connection-a' },
    { roomId: 'room-b', sessionId: 'session-b', connectionId: 'connection-b' },
  ]);
  expect(runner.started).toHaveLength(2);
  // Each session keeps its own conversation state directory and journals.
  expect(new Set(runner.started.map((context) => context.sessionId)).size).toBe(2);

  // A repeated dispatch of a live room is the same session, not a second one.
  await host.dispatch('room-a', first);
  expect(runner.started).toHaveLength(2);

  await host.stopAll();
});

it('keeps the other room running when one room session is stopped', async () => {
  const root = await workspace();
  const runner = recordingRunner();
  const host = hostFor(root, runner.run);
  await host.dispatch(
    'room-a',
    configFor({ cwd: root, roomId: 'room-a', sessionId: 'session-a', connectionId: 'a' })
  );
  await host.dispatch(
    'room-b',
    configFor({ cwd: root, roomId: 'room-b', sessionId: 'session-b', connectionId: 'b' })
  );

  await host.stop('session-a');

  expect(runner.finished.map((context) => context.sessionId)).toEqual(['session-a']);
  expect(host.live()).toEqual([{ roomId: 'room-b', sessionId: 'session-b', connectionId: 'b' }]);
  expect(host.failures()).toEqual([]);

  // The stopped room can be admitted again; its slot was released.
  await host.dispatch(
    'room-a',
    configFor({ cwd: root, roomId: 'room-a', sessionId: 'session-a2', connectionId: 'a2' })
  );
  expect(host.live().map((context) => context.sessionId)).toEqual(['session-b', 'session-a2']);
  await host.stopAll();
});

it('contains a faulting room session instead of taking the host down', async () => {
  const root = await workspace();
  const runner = recordingRunner();
  runner.faults.set('session-a', new Error('provider exploded'));
  const host = hostFor(root, runner.run);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await host.dispatch(
      'room-a',
      configFor({ cwd: root, roomId: 'room-a', sessionId: 'session-a', connectionId: 'a' })
    );
    await host.dispatch(
      'room-b',
      configFor({ cwd: root, roomId: 'room-b', sessionId: 'session-b', connectionId: 'b' })
    );
    await vi.waitFor(() => expect(host.failures()).toHaveLength(1));

    expect(host.failures()[0]).toMatchObject({
      context: { roomId: 'room-a', sessionId: 'session-a' },
      message: 'provider exploded',
    });
    await vi.waitFor(() =>
      expect(host.live().map((context) => context.sessionId)).toEqual(['session-b'])
    );
    // The failure is durable where Console already looks for one.
    await vi.waitFor(async () =>
      expect(
        JSON.parse(await readFile(join(root, 'session-a', 'supervisor', 'failure.json'), 'utf8'))
          .message
      ).toBe('provider exploded')
    );
  } finally {
    errors.mockRestore();
  }
  await host.stopAll();
});

it('gives every room session its own immutable provider environment', async () => {
  const root = await workspace();
  const runner = recordingRunner();
  const host = hostFor(root, runner.run);
  await host.dispatch(
    'room-a',
    configFor({ cwd: root, roomId: 'room-a', sessionId: 'session-a', connectionId: 'connection-a' })
  );
  await host.dispatch(
    'room-b',
    configFor({ cwd: root, roomId: 'room-b', sessionId: 'session-b', connectionId: 'connection-b' })
  );

  expect(runner.envs.get('session-a')).toEqual({
    SWITCH_CONNECTION_ID: 'connection-a',
    SWITCHDASH_SESSION_ID: 'session-a',
    SWITCH_BOUND_ROOM_ID: 'room-a',
  });
  expect(runner.envs.get('session-b')).toEqual({
    SWITCH_CONNECTION_ID: 'connection-b',
    SWITCHDASH_SESSION_ID: 'session-b',
    SWITCH_BOUND_ROOM_ID: 'room-b',
  });
  // Running two sessions changed nothing on the host's own environment.
  expect({
    SWITCH_CONNECTION_ID: process.env.SWITCH_CONNECTION_ID,
    SWITCHDASH_SESSION_ID: process.env.SWITCHDASH_SESSION_ID,
  }).toEqual(hostEnvironmentBaseline());

  const context = host.live()[0]!;
  expect(() =>
    assertSessionEnvironment(context, runner.envs.get('session-b')!, 'session-b')
  ).toThrow('prepared provider input for session-b');
  expect(() =>
    assertSessionEnvironment(context, { SWITCH_CONNECTION_ID: 'connection-b' }, 'session-a')
  ).toThrow('rather than connection-a');
  // A session pinned to another room can never reach a provider.
  expect(() =>
    assertSessionEnvironment(
      context,
      { SWITCH_CONNECTION_ID: 'connection-a', SWITCH_BOUND_ROOM_ID: 'room-b' },
      'session-a'
    )
  ).toThrow('bound to room room-b rather than room-a');
  await host.stopAll();
});

it('refuses a room that already has a live session rather than guessing', async () => {
  const root = await workspace();
  const runner = recordingRunner();
  const host = hostFor(root, runner.run);
  await host.dispatch(
    'room-a',
    configFor({ cwd: root, roomId: 'room-a', sessionId: 'session-a', connectionId: 'a' })
  );
  await expect(
    host.dispatch(
      'room-a',
      configFor({ cwd: root, roomId: 'room-a', sessionId: 'session-other', connectionId: 'other' })
    )
  ).rejects.toThrow('already served by session session-a');
  expect(runner.started).toHaveLength(1);
  await host.stopAll();
});

it('admits an event only to the session bound to its room', async () => {
  const root = await workspace();
  const config = configFor({
    cwd: root,
    roomId: 'room-a',
    sessionId: 'session-a',
    connectionId: 'a',
  });
  expect(roomSessionContext('room-a', config)).toEqual({
    roomId: 'room-a',
    sessionId: 'session-a',
    connectionId: 'a',
  });
  // The room of the event, not the room of whichever session is at hand.
  expect(() => roomSessionContext('room-b', config)).toThrow(
    'bound to [room-a]. A room session serves exactly one room'
  );
  const twoRooms = structuredClone(config);
  twoRooms.roomConnection!.rooms = ['room-a', 'room-b'];
  expect(() => roomSessionContext('room-a', twoRooms)).toThrow('serves exactly one room');
  const unbound = structuredClone(config);
  delete unbound.roomConnection;
  expect(() => roomSessionContext('room-a', unbound)).toThrow('no room connection identity');
});

it('keeps the server refusal that explains why a room was never admitted', () => {
  const base = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const admission = streamAdmissionLog(base);
  expect(admission.lastRefusal()).toBeNull();
  admission.log.debug('opening', { event: 'switch_stream_open' });
  expect(admission.lastRefusal()).toBeNull();
  admission.log.warn('stream error', {
    event: 'switch_stream_error',
    error: 'HTTP 409: agent a already has 32 open connections; close one before opening another',
  });
  expect(admission.lastRefusal()).toContain('32 open connections');
  expect(base.warn).toHaveBeenCalled();
  expect(base.debug).toHaveBeenCalled();
});

it('stops waiting on a room session that will not drain, and still lets the host exit', async () => {
  const root = await workspace();
  const stuck = new Set(['session-stuck']);
  const run: RoomSessionRun = async ({ context, signal }) => {
    if (stuck.has(context.sessionId)) return new Promise<void>(() => {});
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };
  const host = hostFor(root, run, 20);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await host.dispatch(
      'room-stuck',
      configFor({ cwd: root, roomId: 'room-stuck', sessionId: 'session-stuck', connectionId: 's' })
    );
    await host.dispatch(
      'room-ok',
      configFor({ cwd: root, roomId: 'room-ok', sessionId: 'session-ok', connectionId: 'o' })
    );

    // Bounded: this resolves even though one session never finishes draining.
    await host.stopAll();

    expect(errors.mock.calls.flat().join(' ')).toContain('room-stuck (session-stuck)');
    expect(host.live().map((context) => context.sessionId)).toEqual(['session-stuck']);
  } finally {
    errors.mockRestore();
  }
});

it('replaces a room fault rather than accumulating one per retry, and clears it on restart', async () => {
  const root = await workspace();
  const runner = recordingRunner();
  runner.faults.set('session-a', new Error('first failure'));
  const host = hostFor(root, runner.run);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const failing = configFor({
      cwd: root,
      roomId: 'room-a',
      sessionId: 'session-a',
      connectionId: 'a',
    });
    const settled = async () => {
      await vi.waitFor(() => expect(host.live()).toEqual([]));
    };
    await host.dispatch('room-a', failing);
    await settled();
    expect(host.failures()).toHaveLength(1);

    runner.faults.set('session-a', new Error('second failure'));
    await host.dispatch('room-a', failing);
    await settled();
    expect(host.failures()).toEqual([
      {
        context: { roomId: 'room-a', sessionId: 'session-a', connectionId: 'a' },
        message: 'second failure',
      },
    ]);

    // A room that starts again has no outstanding failure.
    runner.faults.clear();
    await host.dispatch('room-a', failing);
    expect(host.failures()).toEqual([]);
  } finally {
    errors.mockRestore();
  }
  await host.stopAll();
});

it('refuses a room whose session could not be proven stopped', async () => {
  const root = await workspace();
  const config = configFor({
    cwd: root,
    roomId: 'room-a',
    sessionId: 'session-a',
    connectionId: 'a',
  });
  const run: RoomSessionRun = async ({ context }) => {
    throw new ResidentTeardownError(context, new Error('provider child would not exit'), null);
  };
  const host = hostFor(root, run);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    // A session that could not be torn down keeps its ownership record; the
    // record is what stops anything else concluding the provider stopped.
    const owner = join(root, 'session-a', 'supervisor', 'owner.json');
    await mkdir(join(root, 'session-a', 'supervisor'), { recursive: true });
    await writeFile(owner, JSON.stringify({ pid: process.pid, resident: true }));

    await host.dispatch('room-a', config);
    await vi.waitFor(() => expect(host.failures()).toHaveLength(1));
    await vi.waitFor(() => expect(host.live()).toEqual([]));

    await expect(host.dispatch('room-a', config)).rejects.toThrow(
      /cannot start a session yet.*could not be proven stopped/s
    );
    // The record was not cleared behind the refusal.
    expect(JSON.parse(await readFile(owner, 'utf8'))).toEqual({
      pid: process.pid,
      resident: true,
    });

    // Once the processes are gone and the record with them, the room reopens.
    await rm(owner);
    await expect(host.dispatch('room-a', config)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(host.live()).toEqual([]));
  } finally {
    errors.mockRestore();
  }
  await host.stopAll();
});

it('admits a replacement once the old session has left the room', async () => {
  const root = await workspace();
  const runner = recordingRunner();
  const host = hostFor(root, runner.run);
  const first = configFor({
    cwd: root,
    roomId: 'room-a',
    sessionId: 'session-a',
    connectionId: 'a',
  });
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await host.dispatch('room-a', first);
    // The session's connection reports it is serving another room. Fixed-room
    // ownership says it is no longer this room's session.
    await mkdir(join(root, 'session-a'), { recursive: true });
    await writeFile(
      join(root, 'session-a', 'room-inbox.jsonl'),
      JSON.stringify({ type: 'rooms', rooms: ['room-b'] }) + '\n'
    );

    const replacement = configFor({
      cwd: root,
      roomId: 'room-a',
      sessionId: 'session-a2',
      connectionId: 'a2',
    });
    await expect(host.dispatch('room-a', replacement)).resolves.toBeUndefined();

    // Room A has exactly one live session and it is the new one. Nothing was
    // started for room B: a room session does not move.
    expect(host.live()).toEqual([
      { roomId: 'room-a', sessionId: 'session-a2', connectionId: 'a2' },
    ]);
    expect(runner.finished.map((context) => context.sessionId)).toEqual(['session-a']);
  } finally {
    warnings.mockRestore();
  }
  await host.stopAll();
});

it('refuses a replacement when stopping the session that left the room times out', async () => {
  const root = await workspace();
  const started: string[] = [];
  const host = hostFor(
    root,
    async ({ context, signal }) => {
      started.push(context.sessionId);
      // The old session never drains: its execution stays unaccounted for.
      if (context.sessionId === 'old') return new Promise<void>(() => {});
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
    },
    10
  );
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await host.dispatch(
      'room-a',
      configFor({ cwd: root, roomId: 'room-a', sessionId: 'old', connectionId: 'a' })
    );
    await mkdir(join(root, 'old'), { recursive: true });
    await writeFile(
      join(root, 'old', 'room-inbox.jsonl'),
      JSON.stringify({ type: 'rooms', rooms: ['room-b'] }) + '\n'
    );

    const replacement = configFor({
      cwd: root,
      roomId: 'room-a',
      sessionId: 'new',
      connectionId: 'b',
    });
    await expect(host.dispatch('room-a', replacement)).rejects.toThrow('did not stop within 10ms');
    expect(started).toEqual(['old']);
    // The room is still mapped to the session nobody can account for.
    expect(host.live().map((context) => context.sessionId)).toEqual(['old']);
    // And it stays refused on a retry.
    await expect(host.dispatch('room-a', replacement)).rejects.toThrow('cannot start a session');
    expect(started).toEqual(['old']);
  } finally {
    errors.mockRestore();
    warnings.mockRestore();
  }
  await host.stopAll();
});

it('sends a provider it cannot fence to its own process tree, and says so', async () => {
  const root = await workspace();
  const runner = recordingRunner();
  const host = hostFor(root, runner.run);
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    // Claude's SDK spawns the provider itself and takes no `detached` option,
    // so the resident host could never reap what that session started.
    await host.dispatch(
      'room-claude',
      configFor({
        cwd: root,
        roomId: 'room-claude',
        sessionId: 'session-claude',
        connectionId: 'c',
        provider: 'claude',
      })
    );
    expect(delegated).toEqual([{ roomId: 'room-claude', sessionId: 'session-claude' }]);
    expect(runner.started).toEqual([]);
    expect(host.live()).toEqual([]);
    // Disclosed, not quiet: the warning names the provider and the reason.
    expect(warnings.mock.calls.flat().join(' ')).toContain('runs claude in its own process tree');
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(join(root, 'resident.json'), 'utf8')).delegated).toEqual([
        {
          roomId: 'room-claude',
          sessionId: 'session-claude',
          connectionId: 'c',
          dispatch: 'spawn',
          reason: 'provider descendants cannot be process-group fenced',
        },
      ])
    );

    // A fenceable provider still runs in the host.
    await host.dispatch(
      'room-codex',
      configFor({ cwd: root, roomId: 'room-codex', sessionId: 'session-codex', connectionId: 'x' })
    );
    expect(runner.started.map((context) => context.sessionId)).toEqual(['session-codex']);
    expect(delegated).toHaveLength(1);
  } finally {
    warnings.mockRestore();
  }
  await host.stopAll();
});
