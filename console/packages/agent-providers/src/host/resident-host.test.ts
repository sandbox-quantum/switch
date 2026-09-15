import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ResidentSessions,
  assertSessionEnvironment,
  hostEnvironmentBaseline,
  roomSessionContext,
  streamAdmissionLog,
  type RoomSessionContext,
  type RoomSessionRun,
} from './resident-host';
import { sharedConfigSchema, type SharedHostConfig } from './shared-config';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('./launch', () => ({
  sharedSessionRoot: (id: string) => join(paths.root, id),
  ensureSharedProcess: vi.fn(),
}));

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'resident-host-test-'));
  roots.push(root);
  paths.root = root;
  return root;
}

function configFor(input: {
  cwd: string;
  roomId: string;
  sessionId: string;
  connectionId: string;
}): SharedHostConfig {
  return sharedConfigSchema.parse({
    session: {
      sessionId: input.sessionId,
      agentId: 'agent',
      hostId: 'host',
      epoch: randomUUID(),
      provider: 'claude',
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
      provider: 'claude',
      input: {
        sessionId: input.sessionId,
        cwd: input.cwd,
        runtimeMode: 'approval-required',
        env: {
          SWITCH_CONNECTION_ID: input.connectionId,
          SWITCHDASH_SESSION_ID: input.sessionId,
        },
        mcpServers: {},
      },
    },
    roomConnection: { connectionId: input.connectionId, rooms: [input.roomId], startCursor: 0 },
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
  const host = new ResidentSessions(root, runner.run);
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
  const host = new ResidentSessions(root, runner.run);
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
  const host = new ResidentSessions(root, runner.run);
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
  const host = new ResidentSessions(root, runner.run);
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
  });
  expect(runner.envs.get('session-b')).toEqual({
    SWITCH_CONNECTION_ID: 'connection-b',
    SWITCHDASH_SESSION_ID: 'session-b',
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
  await host.stopAll();
});

it('refuses a room that already has a live session rather than guessing', async () => {
  const root = await workspace();
  const runner = recordingRunner();
  const host = new ResidentSessions(root, runner.run);
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
