import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Runtime from '@sandboxaq/switch-agent-runtime';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureSharedProcess } from './launch';
import { sharedConfigSchema } from './shared-config';
import {
  replaceSupersededSessions,
  runSharedWatcher,
  SharedWatchAssignments,
} from './shared-watcher';

const paths = vi.hoisted(() => ({ root: '' }));
const supervisors = vi.hoisted(() => new Map<string, { build: unknown }>());
vi.mock('./launch', () => ({
  sharedSessionRoot: (id: string) => join(paths.root, id),
  sharedSessionsBase: () => paths.root,
  liveSupervisor: (root: string) => Promise.resolve(supervisors.get(root) ?? null),
  ensureSharedProcess: vi.fn(),
}));
type StreamDeps = Pick<
  Runtime.SwitchEventStreamDeps,
  'startCursor' | 'signal' | 'onEvent' | 'onGap'
>;
const streams = vi.hoisted(() => [] as StreamDeps[]);
vi.mock('@sandboxaq/switch-agent-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof Runtime>()),
  SwitchEventStream: class {
    constructor(deps: StreamDeps) {
      streams.push(deps);
    }
    start() {}
  },
}));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(['claude', 'codex', 'opencode', 'antigravity', 'cursor'])(
  'keeps %s room assignments across a crash before launch and duplicate delivery',
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-test-'));
    roots.push(root);
    paths.root = root;
    const template = sharedConfigSchema.parse({
      session: {
        sessionId: 'watcher',
        agentId: randomUUID(),
        hostId: 'host',
        epoch: 'initial',
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
          sessionId: 'watcher',
          cwd: root,
          runtimeMode: 'approval-required',
          env: { TEST_SETTING: 'preserved', SWITCHDASH_SESSION_ID: 'watcher' },
          mcpServers: {},
        },
      },
      roomConnection: { connectionId: 'watcher', rooms: [], startCursor: 0 },
    });
    const event = { sequence: 7, roomId: 'room', messageId: 'message' };
    const first = await (await SharedWatchAssignments.open(root)).assign(template, event);
    const restarted = await SharedWatchAssignments.open(root);
    expect(restarted.cursor).toBe(7);
    expect(await restarted.assign(template, event)).toEqual(first);
    expect(await restarted.assign(template, { ...event, sequence: 8, messageId: 'next' })).toEqual(
      first
    );
    expect(restarted.sessions()).toHaveLength(1);
    expect(first.roomConnection).toMatchObject({ rooms: ['room'], startCursor: 6 });
    expect(first.start.input.env).toEqual({
      TEST_SETTING: 'preserved',
      SWITCHDASH_SESSION_ID: first.session.sessionId,
    });
    await expect(restarted.assign(template, { ...event, messageId: 'forged' })).rejects.toThrow(
      'identity'
    );
    const another = await restarted.assign(template, { ...event, sequence: 9, roomId: 'another' });
    expect(another.session.sessionId).not.toBe(first.session.sessionId);
    const firstRoot = join(root, first.session.sessionId);
    await mkdir(firstRoot);
    await writeFile(
      join(firstRoot, 'room-inbox.jsonl'),
      JSON.stringify({ type: 'rooms', rooms: ['another'] }) + '\n'
    );
    const returned = await restarted.assign(template, {
      ...event,
      sequence: 10,
      messageId: 'returned',
    });
    expect(returned.session.sessionId).not.toBe(first.session.sessionId);
    expect(returned.roomConnection?.rooms).toEqual(['room']);
    expect(await restarted.assign(template, event)).toEqual(first);
    const returnedRoot = join(root, returned.session.sessionId);
    await mkdir(returnedRoot);
    await writeFile(join(returnedRoot, 'room-inbox.jsonl'), '{');
    await expect(
      restarted.assign(template, { ...event, sequence: 11, messageId: 'after-crash' })
    ).resolves.toEqual(returned);
    expect(restarted.cursor).toBe(11);
  }
);

function template(root: string) {
  return sharedConfigSchema.parse({
    session: {
      sessionId: 'watcher',
      agentId: randomUUID(),
      hostId: 'host',
      epoch: 'initial',
      provider: 'codex',
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
      provider: 'codex',
      input: {
        sessionId: 'watcher',
        cwd: root,
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {},
      },
    },
    roomConnection: { connectionId: 'watcher', rooms: [], startCursor: 0 },
  });
}

it('forgets its saved position after the server numbering restarts, keeping room sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-restart-'));
  roots.push(root);
  paths.root = root;
  const config = template(root);
  const assignments = await SharedWatchAssignments.open(root);
  const before = await assignments.assign(config, {
    sequence: 13,
    roomId: 'room',
    messageId: 'before',
  });
  expect(assignments.cursor).toBe(13);

  await assignments.restart();

  // A saved position from the old numbering would be asked for again on every
  // reconnect, so the watcher must forget it rather than stall behind head.
  expect(assignments.cursor).toBe(0);
  const reloaded = await SharedWatchAssignments.open(root);
  expect(reloaded.cursor).toBe(0);

  // Low sequence numbers are fresh events now, not duplicates of old ones.
  const after = await reloaded.assign(config, { sequence: 2, roomId: 'other', messageId: 'after' });
  expect(after.session.sessionId).not.toBe(before.session.sessionId);
  expect(reloaded.cursor).toBe(2);

  // The room keeps the session it already had.
  expect(
    await reloaded.assign(config, { sequence: 3, roomId: 'room', messageId: 'again' })
  ).toEqual(before);
  expect(reloaded.sessions().map((entry) => entry.session.sessionId)).toEqual([
    before.session.sessionId,
    after.session.sessionId,
  ]);
});

async function watcherRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  paths.root = join(root, 'sessions');
  streams.length = 0;
  vi.mocked(ensureSharedProcess).mockClear();
  const config = template(root);
  config.execution = {
    credentialsPath: join(root, 'credentials.json'),
    inheritEnv: [],
    mcpRuntime: 'runtime',
    codexConfig: '',
    skill: '',
    context: '',
  };
  await writeFile(
    config.execution.credentialsPath,
    JSON.stringify({
      env: {
        SWITCH_API_ENDPOINT: 'https://switch.example.test',
        SWITCH_API_TOKEN: 'placeholder',
        SWITCH_AGENT_ID: config.session.agentId,
      },
    })
  );
  await writeFile(join(root, 'watch.json'), JSON.stringify({ enabled: true }));
  await writeFile(join(root, 'config.json'), JSON.stringify(config));
  return { root, config };
}

async function startWatcher(root: string, config: ReturnType<typeof template>) {
  const stop = new AbortController();
  const watching = runSharedWatcher(root, config, stop.signal, {
    build: 'build',
    start: vi.fn(),
    stop: vi.fn(),
  });
  await vi.waitFor(() => expect(streams).toHaveLength(1));
  return async () => {
    stop.abort();
    await watching;
  };
}

it('opens the stream at the oldest retained event when its journal is empty', async () => {
  const { root, config } = await watcherRoot('shared-watch-empty-');
  const stopWatcher = await startWatcher(root, config);
  await stopWatcher();

  expect(streams[0]!.startCursor).toBe(0);
});

it('restart gap re-reads the retained backlog once from 0, without starting an assigned message twice', async () => {
  const { root, config } = await watcherRoot('shared-watch-replay-');
  const original = await (
    await SharedWatchAssignments.open(root)
  ).assign(config, { sequence: 9, roomId: 'room', messageId: 'wake' });
  const stopWatcher = await startWatcher(root, config);
  expect(streams[0]!.startCursor).toBe(9);

  await streams[0]!.onGap({
    fromSequence: 2,
    resumedAt: 2,
    reason: 'the server restarted since your last connection',
    cursorReset: true,
  });
  expect(streams).toHaveLength(2);
  expect(streams[1]!.startCursor).toBe(0);
  expect(streams[0]!.signal.aborted).toBe(true);
  expect(streams[1]!.signal.aborted).toBe(false);

  await streams[1]!.onEvent({
    type: 'message',
    room_id: 'room',
    sequence: 1,
    payload: {
      addressed: true,
      sender: '@user:example.test',
      sender_name: 'User',
      message_id: 'wake',
      body: 'wake up',
      timestamp: 0,
    },
  });
  await stopWatcher();

  const calls = vi.mocked(ensureSharedProcess).mock.calls;
  expect(calls).toHaveLength(2);
  expect(new Set(calls.map((call) => call[0].config.session.sessionId))).toEqual(
    new Set([original.session.sessionId])
  );
  expect((await SharedWatchAssignments.open(root)).sessions()).toHaveLength(1);
});

it('other gaps do not replay', async () => {
  const { root, config } = await watcherRoot('shared-watch-gap-');
  const stopWatcher = await startWatcher(root, config);

  await streams[0]!.onGap({
    fromSequence: 2,
    resumedAt: 4,
    reason: 'events expired',
    cursorReset: false,
  });
  await streams[0]!.onGap({ fromSequence: 2, reason: 'events were missed' });
  await stopWatcher();

  expect(streams).toHaveLength(1);
});

it('restarts only the live sessions of this agent left on a superseded build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-superseded-'));
  roots.push(root);
  paths.root = root;
  supervisors.clear();
  vi.mocked(ensureSharedProcess).mockClear();
  const agentId = randomUUID();
  const save = async (name: string, sessionId: string, owner: string) => {
    const config = template(root);
    config.session = { ...config.session, sessionId, agentId: owner };
    config.start.input.sessionId = sessionId;
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'config.json'), JSON.stringify(config));
    return join(root, name);
  };
  const superseded = await save('superseded', 'superseded-session', agentId);
  const current = await save('current', 'current-session', agentId);
  const other = await save('other', 'other-session', randomUUID());
  await save('idle', 'idle-session', agentId);
  supervisors.set(superseded, { build: '/host/shared-host-old.mjs' });
  supervisors.set(current, { build: '/host/shared-host-new.mjs' });
  supervisors.set(other, { build: '/host/shared-host-old.mjs' });

  await replaceSupersededSessions(agentId, {
    build: '/host/shared-host-new.mjs',
    start: vi.fn(),
    stop: vi.fn(),
  });

  expect(vi.mocked(ensureSharedProcess).mock.calls.map((call) => call[0].root)).toEqual([
    superseded,
  ]);
  expect(vi.mocked(ensureSharedProcess).mock.calls[0]![0].restart).toBe(false);
});
