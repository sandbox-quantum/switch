import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Runtime from '@sandboxaq/switch-agent-runtime';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureSharedProcess } from './launch';
import { sharedConfigSchema } from './shared-config';
import { runSharedWatcher, SharedWatchAssignments } from './shared-watcher';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('./launch', () => ({
  sharedSessionRoot: (id: string) => join(paths.root, id),
  sharedSessionsBase: () => paths.root,
  liveSupervisor: () => Promise.resolve(null),
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

function template(root: string, agentId: string, sessionId = 'watcher') {
  return sharedConfigSchema.parse({
    session: {
      sessionId,
      agentId,
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
      input: { sessionId, cwd: root, runtimeMode: 'approval-required', env: {}, mcpServers: {} },
    },
    roomConnection: { connectionId: sessionId, rooms: [], startCursor: 0 },
    execution: {
      credentialsPath: join(root, 'credentials.json'),
      inheritEnv: [],
      mcpRuntime: 'runtime',
      codexConfig: '',
      skill: '',
      context: '',
    },
  });
}

async function setup(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  paths.root = join(root, 'sessions');
  await mkdir(paths.root, { recursive: true });
  streams.length = 0;
  vi.mocked(ensureSharedProcess).mockClear();
  const config = template(root, randomUUID());
  await writeFile(
    config.execution!.credentialsPath,
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

async function start(root: string, config: ReturnType<typeof template>) {
  const stop = new AbortController();
  const watching = runSharedWatcher(root, config, stop.signal, {
    build: 'b',
    start: vi.fn(),
    stop: vi.fn(),
  });
  await vi.waitFor(() => expect(streams).toHaveLength(1));
  return async () => {
    stop.abort();
    await watching;
  };
}

const message = (sequence: number, room_id: string, message_id: string) => ({
  type: 'message' as const,
  room_id,
  sequence,
  payload: {
    addressed: true,
    sender: '@user:example.test',
    sender_name: 'User',
    message_id,
    body: 'hi',
    timestamp: 0,
  },
});

/** A session root showing the session already received and acknowledged `messageId` in `roomId`. */
async function answered(
  sessionId: string,
  config: object,
  roomId: string,
  messageId: string,
  sequence: number,
  inbox: object[]
) {
  const dir = join(paths.root, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  const key = JSON.stringify([roomId, messageId]);
  await writeFile(
    join(dir, 'room-inbox.jsonl'),
    [
      { type: 'rooms', rooms: [roomId] },
      { type: 'received', sequence, roomId, messageId, missed: 0, gap: null },
      { type: 'ack', sequence, identity: key },
    ]
      .map((r) => JSON.stringify(r) + '\n')
      .join('')
  );
  await writeFile(join(dir, 'inbox.jsonl'), inbox.map((r) => JSON.stringify(r) + '\n').join(''));
}

const launched = () => vi.mocked(ensureSharedProcess).mock.calls.map((c) => c[0].config);

it('does not relaunch a fenced session with pending input', async () => {
  const { root, config } = await setup('fenced-watcher-');
  const sessionId = randomUUID();
  await answered(sessionId, template(root, config.session.agentId, sessionId), '!room', 'M', 1, [
    { type: 'stopped' },
  ]);
  await writeFile(
    join(paths.root, sessionId, 'room-inbox.jsonl'),
    [
      { type: 'rooms', rooms: ['!room'] },
      { type: 'received', sequence: 1, roomId: '!room', messageId: 'M', missed: 0, gap: null },
    ]
      .map((record) => JSON.stringify(record) + '\n')
      .join('')
  );
  const stop = await start(root, config);
  await streams[0]!.onEvent(message(1, '!room', 'M'));
  await streams[0]!.onEvent(message(2, '!room', 'next'));
  await stop();
  expect(launched()).toHaveLength(1);
  expect(launched()[0]!.session.sessionId).not.toBe(sessionId);
  expect(launched()[0]!.roomConnection?.startCursor).toBe(1);
});

it('skips replay of a message answered by a session created outside the watcher', async () => {
  const { root, config } = await setup('w5a-');
  // The watcher's journal cursor is its last *assignment*, here seq 3 in another room.
  const other = await (
    await SharedWatchAssignments.open(root)
  ).assign(config, { sequence: 3, roomId: '!other', messageId: 'old' });
  // Session S was started by hosted-control's `start` op (not in assignments.jsonl),
  // joined !room and answered M at seq 10 before the worker idled out.
  const S = randomUUID();
  await answered(S, template(root, config.session.agentId, S), '!room', 'M', 10, []);

  const stop = await start(root, config);
  expect(streams[0]!.startCursor).toBe(3); // replays everything after its last assignment
  // On boot S has not reclaimed !room yet, so the server hands M to the all-rooms watcher.
  await streams[0]!.onEvent(message(10, '!room', 'M'));
  await stop();

  const fresh = launched().filter((c) => c.session.sessionId !== other.session.sessionId);
  // Correct behaviour: no new session for an already-answered message.
  expect(fresh.map((c) => ({ id: c.session.sessionId, room: c.roomConnection }))).toEqual([]);
});

it('skips replay of an answered message after its session stops', async () => {
  const { root, config } = await setup('w5b-');
  const S = await (
    await SharedWatchAssignments.open(root)
  ).assign(config, { sequence: 9, roomId: '!room', messageId: 'first' });
  const stop = await start(root, config);
  // New server: S reconnected first, received M as seq 1 and answered it, then the user stopped S.
  await answered(S.session.sessionId, S, '!room', 'M', 1, [{ type: 'stopped' }]);
  await streams[0]!.onGap({
    fromSequence: 2,
    resumedAt: 2,
    reason: 'the server restarted',
    cursorReset: true,
  });
  expect(streams[1]!.startCursor).toBe(0);
  await streams[1]!.onEvent(message(1, '!room', 'M'));
  await stop();

  const fresh = launched().filter((c) => c.session.sessionId !== S.session.sessionId);
  expect(fresh.map((c) => ({ id: c.session.sessionId, room: c.roomConnection }))).toEqual([]);
});

it('keeps a resumed session when another message arrives', async () => {
  const { root, config } = await setup('w5c-');
  const S = await (
    await SharedWatchAssignments.open(root)
  ).assign(config, { sequence: 9, roomId: '!room', messageId: 'first' });
  await answered(S.session.sessionId, S, '!room', 'first', 9, [
    { type: 'stopped' },
    { type: 'resumed', operationId: randomUUID() },
  ]);
  const stop = await start(root, config);
  await streams[0]!.onEvent(message(10, '!room', 'next'));
  await stop();
  expect(new Set(launched().map((c) => c.session.sessionId))).toEqual(
    new Set([S.session.sessionId])
  );
});
