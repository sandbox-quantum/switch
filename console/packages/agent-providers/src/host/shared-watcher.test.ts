import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as runtime from '@sandboxaq/switch-agent-runtime';
import type { AgentBridgeEvent, SwitchEventStreamDeps } from '@sandboxaq/switch-agent-runtime';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureSharedProcess, type Supervision } from './launch';
import { type SessionRequest, SessionLinks } from './session-channel';
import { sharedConfigSchema } from './shared-config';
import {
  replaceSupersededSessions,
  runSharedWatcher,
  SharedWatchAssignments,
  supersededSessions,
} from './shared-watcher';
import { clearTakenOver, recordTakenOver } from './taken-over';

const paths = vi.hoisted(() => ({ root: '' }));
const supervisors = vi.hoisted(() => new Map<string, { build: unknown }>());
vi.mock('./launch', () => ({
  sharedSessionRoot: (id: string) => join(paths.root, id),
  sharedSessionsBase: () => paths.root,
  liveSupervisor: (root: string) => Promise.resolve(supervisors.get(root) ?? null),
  ensureSharedProcess: vi.fn(),
}));
const streams = vi.hoisted(() => [] as SwitchEventStreamDeps[]);
const declarations = vi.hoisted(() => [] as boolean[]);
vi.mock('@sandboxaq/switch-agent-runtime', async (importOriginal) => {
  const original = await importOriginal<typeof runtime>();
  return {
    ...original,
    SwitchEventStream: class {
      constructor(private readonly deps: SwitchEventStreamDeps) {
        streams.push(deps);
        declarations.push(deps.spawnCapable === true);
      }
      start(): void {}
      setSpawnCapable(capable: boolean): void {
        declarations.push(capable);
      }
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  streams.length = 0;
  declarations.length = 0;
  supervisors.clear();
  vi.mocked(ensureSharedProcess).mockReset();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type HostChild = EventEmitter & {
  send: (message: unknown, callback: (error: Error | null) => void) => boolean;
};

/**
 * The session hosts a watcher is the parent of, as it sees them over IPC. A
 * host is attached to its link when `start` is called — what the supervisor
 * does on spawning one — says it is ready straight away, and records every
 * request it is sent. It answers each one unless told to `drop` them, in which
 * case it stops before answering, as a host that crashed would.
 */
function sessionHosts() {
  const links = new SessionLinks();
  const children = new Map<string, HostChild>();
  const requests: { root: string; request: SessionRequest }[] = [];
  const hosts = {
    links,
    requests,
    drop: false,
    supervision: {
      build: 'build',
      start: async () => {},
      stop: async () => {},
      links,
    } as Supervision,
    /** Starts a host at `root` unless one is running there already. */
    start: async (root: string): Promise<{ created: boolean }> => {
      if (links.ready(root)) return { created: false };
      const child = new EventEmitter() as HostChild;
      child.send = (message, callback) => {
        callback(null);
        const { id, request } = message as { id: number; request: SessionRequest };
        requests.push({ root, request });
        setImmediate(() => {
          if (hosts.drop) child.emit('exit', 1, null);
          else child.emit('message', { kind: 'reply', id, ok: true, value: null });
        });
        return true;
      };
      children.set(root, child);
      links.attach(root, child as unknown as ChildProcess);
      child.emit('message', { kind: 'ready' });
      return { created: true };
    },
    /** The host at `root` exits. */
    exit: (root: string) => children.get(root)?.emit('exit', 0, null),
    /** What the host at `root` was asked, in order. */
    to: (root: string) => requests.filter((entry) => entry.root === root).map((e) => e.request),
  };
  vi.mocked(ensureSharedProcess).mockImplementation(({ root }) => hosts.start(root));
  return hosts;
}

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
      roomConnection: { connectionId: 'watcher' },
    });
    const event = { sequence: 7, roomId: 'room', messageId: 'message' };
    const opened = await SharedWatchAssignments.open(root);
    const first = await opened.assign(template, event);
    await opened.handled(event.sequence);
    const restarted = await SharedWatchAssignments.open(root);
    expect(restarted.cursor).toBe(7);
    // The same delivery served again is the session it was already given, not a
    // second one started to answer the same message.
    expect(await restarted.assign(template, event)).toEqual(first);
    expect(restarted.sessions()).toHaveLength(1);
    // Every session an agent has is reached over the one connection the
    // controller holds, so an assignment inherits it rather than minting one.
    expect(first.roomConnection).toEqual(template.roomConnection);
    // Nothing to claim from Switch: the controller's journal is the record.
    expect(first.grant).toBeUndefined();
    expect(first.start.input.env).toEqual({
      TEST_SETTING: 'preserved',
      SWITCHDASH_SESSION_ID: first.session.sessionId,
    });
    await expect(restarted.assign(template, { ...event, messageId: 'forged' })).rejects.toThrow(
      'identity'
    );
    const another = await restarted.assign(template, {
      ...event,
      sequence: 8,
      roomId: 'another',
      messageId: 'second',
    });
    expect(another.session.sessionId).not.toBe(first.session.sessionId);
    await restarted.handled(8);
    expect(restarted.cursor).toBe(8);
    expect(restarted.sessions()).toHaveLength(2);
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
    roomConnection: { connectionId: 'watcher' },
  });
}

function watchable(root: string) {
  const config = template(root);
  config.execution = {
    credentialsPath: join(root, 'credentials.json'),
    inheritEnv: [],
    mcpRuntime: 'runtime',
    codexConfig: '',
    skill: '',
    context: '',
  };
  return config;
}

/** A session of the same agent on disk, which the server can then be said to have holding a room. */
async function existing(
  root: string,
  config: ReturnType<typeof watchable>
): Promise<{ sessionId: string; sessionRoot: string }> {
  const saved = structuredClone(config);
  saved.session = { ...saved.session, sessionId: randomUUID() };
  const sessionRoot = join(root, saved.session.sessionId);
  await mkdir(sessionRoot, { recursive: true });
  await writeFile(join(sessionRoot, 'config.json'), JSON.stringify(saved));
  return { sessionId: saved.session.sessionId, sessionRoot };
}

/** Records in the controller's journal that `sessionId` serves `roomId`. */
async function assignTo(
  root: string,
  config: ReturnType<typeof watchable>,
  sequence: number,
  roomId: string,
  sessionId: string
): Promise<void> {
  const saved = structuredClone(config);
  saved.session = { ...saved.session, sessionId };
  saved.start.input.sessionId = sessionId;
  await writeFile(
    join(root, 'assignments.jsonl'),
    JSON.stringify({ sequence, roomId, messageId: `seed-${sequence}`, config: saved }) +
      '\n' +
      JSON.stringify({ handled: sequence }) +
      '\n',
    { flag: 'a' }
  );
}

it('stays down while a takeover marker says another client holds the connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-taken-over-'));
  roots.push(root);
  paths.root = root;
  await writeFlags(root, { enabled: true, spawn: true });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { supervision } = sessionHosts();

  await recordTakenOver(root, {
    at: '2026-01-01T00:00:00.000Z',
    reason: 'another stream attached to this connection',
    connectionId: 'watcher',
  });
  // Returns instead of reading the credentials it would need to connect: the
  // watcher never gets as far as reopening the connection it lost.
  await expect(
    runSharedWatcher(root, watchable(root), new AbortController().signal, supervision)
  ).resolves.toBeUndefined();
  expect(warning.mock.calls[0]?.[0]).toContain('stood down at 2026-01-01T00:00:00.000Z');

  // Cleared by the explicit restart, and the watcher tries to connect again —
  // failing here only because this test gave it no credentials to read.
  await clearTakenOver(root);
  await expect(
    runSharedWatcher(root, watchable(root), new AbortController().signal, supervision)
  ).rejects.toThrow('credentials.json');
});

it('asks again for an event it assigned but died before routing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-unrouted-'));
  roots.push(root);
  paths.root = root;
  const config = template(root);
  const assignments = await SharedWatchAssignments.open(root);
  const routed = await assignments.assign(config, {
    sequence: 4,
    roomId: 'room',
    messageId: 'four',
  });
  await assignments.handled(4);
  // Assigned, and then the watcher dies before the session is handed the event.
  const unrouted = await assignments.assign(config, {
    sequence: 6,
    roomId: 'other',
    messageId: 'six',
  });

  const restarted = await SharedWatchAssignments.open(root);
  expect(restarted.cursor).toBe(4);
  // Redelivery finds the same session, so the event is routed where it was
  // always going rather than to a second one.
  expect(
    await restarted.assign(config, { sequence: 6, roomId: 'other', messageId: 'six' })
  ).toEqual(unrouted);
  await restarted.handled(6);
  expect(restarted.cursor).toBe(6);
  expect(restarted.sessions().map((entry) => entry.session.sessionId)).toEqual([
    routed.session.sessionId,
    unrouted.session.sessionId,
  ]);
});

it('resumes a journal written before routing was recorded at its last complete event', async () => {
  // Every assignment in an existing journal is unrouted by this reading, and
  // taking that literally would reopen at the start of the stream — one silent
  // missed session per agent on the upgrade meant to make delivery stronger.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-legacy-'));
  roots.push(root);
  paths.root = root;
  const config = template(root);
  const older = await SharedWatchAssignments.open(root);
  for (const [sequence, roomId] of [
    [4, 'room'],
    [6, 'other'],
    [7, 'third'],
  ] as const)
    await older.assign(config, { sequence, roomId, messageId: `m${sequence}` });

  // Six, because the watcher only assigns the next event once the one before it
  // has been routed — so only the last record is still owed.
  expect((await SharedWatchAssignments.open(root)).cursor).toBe(6);
});

it('resumes at the server head after its numbering restarts', async () => {
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
  await assignments.handled(13);
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
  await reloaded.handled(2);
  expect(reloaded.cursor).toBe(2);
  expect(reloaded.sessions().map((entry) => entry.session.sessionId)).toEqual([
    before.session.sessionId,
    after.session.sessionId,
  ]);
});

/** The rename both Console and the SSH inline script use to replace the file. */
async function writeFlags(root: string, flags: { enabled: boolean; spawn: boolean }) {
  const temporary = join(root, 'watch.json.tmp');
  await writeFile(temporary, JSON.stringify(flags));
  await rename(temporary, join(root, 'watch.json'));
}

async function spawning(root: string) {
  const config = watchable(root);
  await writeFlags(root, { enabled: true, spawn: true });
  await writeFile(join(root, 'config.json'), JSON.stringify(config));
  await writeFile(
    join(root, 'credentials.json'),
    JSON.stringify({
      env: {
        SWITCH_API_ENDPOINT: 'http://127.0.0.1/agent',
        SWITCH_API_TOKEN: 'placeholder-token',
        SWITCH_AGENT_ID: config.session.agentId,
      },
    })
  );
  return config;
}

async function stopSpawning(root: string) {
  await writeFlags(root, { enabled: true, spawn: false });
}

/** Polls: what is waited on crosses a file watch or a queue, not a call. */
async function eventually(reached: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await reached()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The watcher never reached the state this test was waiting for.');
}

/** Whether every event the watcher parked has been taken by its session. */
async function settled(root: string): Promise<boolean> {
  return (await SharedWatchAssignments.open(root)).pending().length === 0;
}

const addressed = (sequence: number, roomId: string): AgentBridgeEvent => ({
  type: 'message',
  room_id: roomId,
  sequence,
  payload: {
    addressed: true,
    sender: '@owner:example.test',
    sender_name: 'Owner',
    message_id: `message-${sequence}`,
    body: 'Run the check',
    timestamp: sequence,
  },
});

it('starts a session saved before the controller over the one connection the agent has', async () => {
  // A config saved when every session opened a connection of its own names
  // that connection. Restarted from this build the session stops opening it,
  // so launching it as saved would bind it to one that never returns.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-upgraded-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const saved = structuredClone(config);
  saved.session = { ...saved.session, sessionId: randomUUID() };
  saved.roomConnection = { connectionId: 'its-own-connection' };
  await writeFile(
    join(root, 'assignments.jsonl'),
    JSON.stringify({ sequence: 1, roomId: 'room', messageId: 'first', config: saved }) +
      '\n' +
      JSON.stringify({ handled: 1 }) +
      '\n'
  );
  const { supervision } = sessionHosts();

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => vi.mocked(ensureSharedProcess).mock.calls.length === 1);
  } finally {
    abort.abort();
    await run;
  }

  const [launched] = vi.mocked(ensureSharedProcess).mock.calls[0]!;
  expect(launched.config.session.sessionId).toBe(saved.session.sessionId);
  expect(launched.config.roomConnection).toEqual(config.roomConnection);
});

it('leaves an event queued behind earlier work unstarted once spawning is turned off', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-queued-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const started: string[] = [];
  let admit: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const hosts = sessionHosts();
  const { supervision } = hosts;
  vi.mocked(ensureSharedProcess).mockImplementation(
    async ({ root: sessionRoot, config: launched }) => {
      started.push(launched.session.sessionId);
      if (started.length === 1) await held;
      return hosts.start(sessionRoot);
    }
  );

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    const stream = streams[0]!;
    void stream.onEvent!(addressed(1, 'room'));
    await eventually(() => started.length >= 1);

    // Admitted while spawning was on, and still waiting on the session before
    // it when the setting changes.
    const queued = stream.onEvent!(addressed(2, 'other'));
    await stopSpawning(root);
    await eventually(() => declarations.includes(false));
    admit();
    await queued;
  } finally {
    // A failed assertion must not leave the directory watch open behind it: the
    // next test then opens its own and the file handles run out.
    admit();
    abort.abort();
    await run;
  }

  const journal = await SharedWatchAssignments.open(root);
  const sessions = journal.sessions().map((assigned) => assigned.session.sessionId);
  expect(sessions).toHaveLength(2);
  expect(started).toEqual([sessions[0]]);
});

it('gives one room one session however close together its first messages arrive', async () => {
  // Two people addressing a quiet room at once must not each get a session of
  // their own: the second would answer from a context the first never had.
  // The first starts the room's session and the second is routed to it.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-concurrent-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const started: string[] = [];
  const hosts = sessionHosts();
  const { supervision } = hosts;
  vi.mocked(ensureSharedProcess).mockImplementation(
    async ({ root: sessionRoot, config: launched }) => {
      started.push(launched.session.sessionId);
      return hosts.start(sessionRoot);
    }
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await Promise.all([
      streams[0]!.onEvent!(addressed(1, 'room')),
      streams[0]!.onEvent!(addressed(2, 'room')),
    ]);
    await eventually(() => settled(root));
  } finally {
    abort.abort();
    await run;
  }

  const journal = await SharedWatchAssignments.open(root);
  expect(journal.sessions()).toHaveLength(1);
  expect(new Set(started).size).toBe(1);
  expect(journal.pending()).toEqual([]);
  expect(
    hosts
      .to(join(root, journal.sessions()[0]!.session.sessionId))
      .map((request) => request.type === 'room' && request.handoff.messageId)
  ).toEqual(['message-1', 'message-2']);
});

it('routes a room that has a session to that session, and starts no other', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-owner-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const owner = await existing(root, config);
  await assignTo(root, config, 1, 'room', owner.sessionId);
  const hosts = sessionHosts();

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(2, 'room'));
    await eventually(() => settled(root));
  } finally {
    abort.abort();
    await run;
  }

  expect(hosts.to(owner.sessionRoot)).toMatchObject([
    {
      type: 'room',
      handoff: {
        sequence: 2,
        roomId: 'room',
        messageId: 'message-2',
        event: { type: 'message', payload: { body: 'Run the check' } },
      },
    },
  ]);
  // Only the room's own session was ever started.
  expect(
    new Set(
      vi.mocked(ensureSharedProcess).mock.calls.map((call) => call[0].config.session.sessionId)
    )
  ).toEqual(new Set([owner.sessionId]));
  const journal = await SharedWatchAssignments.open(root);
  expect(journal.sessions()).toHaveLength(1);
  // Recorded as taken, so a watcher restarted here reopens past it rather than
  // handing the same event over again.
  expect(journal.cursor).toBe(2);
});

it('routes to the session Switch says has connected to the room', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-placed-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const placed = await existing(root, config);
  const hosts = sessionHosts();

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!({ ...addressed(1, 'room'), session_id: placed.sessionId });
    await eventually(() => settled(root));
  } finally {
    abort.abort();
    await run;
  }

  expect(hosts.to(placed.sessionRoot)).toMatchObject([
    { type: 'room', handoff: { sequence: 1, roomId: 'room', messageId: 'message-1' } },
  ]);
  // The room was served without the watcher minting a session for it.
  expect((await SharedWatchAssignments.open(root)).sessions()).toEqual([]);
});

it('still owes an event its session never acknowledged', async () => {
  // The watcher's journal is the only copy of the event once the stream has
  // moved past it. Releasing it before the host has taken it would step the
  // watcher over it on restart, and nothing would be holding it.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-unacknowledged-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const assignments = await SharedWatchAssignments.open(root);
  const assigned = await assignments.assign(config, {
    sequence: 1,
    roomId: 'room',
    messageId: 'first',
  });
  await assignments.handled(1);
  const sessionRoot = join(root, assigned.session.sessionId);
  const hosts = sessionHosts();
  // Every host stops before it answers.
  hosts.drop = true;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(2, 'room'));
    await eventually(() => hosts.to(sessionRoot).length >= 1);
    await eventually(() =>
      warn.mock.calls.some((call) => String(call[0]).includes('did not take message message-2'))
    );
  } finally {
    abort.abort();
    await run;
  }

  const journal = await SharedWatchAssignments.open(root);
  expect(journal.pending()).toMatchObject([
    { sequence: 2, roomId: 'room', messageId: 'message-2', event: { type: 'message' } },
  ]);
  expect(journal.cursor).toBe(1);
});

it('leaves the rest of a restore unstarted once spawning is turned off midway', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-restore-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const assignments = await SharedWatchAssignments.open(root);
  const first = await assignments.assign(config, { sequence: 1, roomId: 'room', messageId: 'a' });
  await assignments.assign(config, { sequence: 2, roomId: 'other', messageId: 'b' });
  const started: string[] = [];
  const hosts = sessionHosts();
  // The restore starts its sessions one at a time, so the setting can change
  // while it is part way through and the loop itself never sees it.
  vi.mocked(ensureSharedProcess).mockImplementation(
    async ({ root: sessionRoot, config: launched }) => {
      started.push(launched.session.sessionId);
      if (started.length === 1) await stopSpawning(root);
      return hosts.start(sessionRoot);
    }
  );

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision);
  try {
    await eventually(() => started.length >= 1);
  } finally {
    abort.abort();
    await run;
  }

  expect(started).toEqual([first.session.sessionId]);
});

it('restarts only the live sessions of this agent left on a superseded build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-superseded-'));
  roots.push(root);
  paths.root = root;
  const agentId = randomUUID();
  const save = async (name: string, sessionId: string, owner: string) => {
    const config = template(root);
    config.session = { ...config.session, sessionId, agentId: owner };
    config.start.input.sessionId = sessionId;
    // What a config saved before the agent had one inbound connection looks
    // like: the session's own, which it stops opening once it is restarted
    // from this build.
    config.roomConnection = { connectionId: `own-${sessionId}` };
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

  const newer: Supervision = {
    build: '/host/shared-host-new.mjs',
    start: vi.fn(),
    stop: vi.fn(),
    links: null,
  };
  await replaceSupersededSessions(
    await supersededSessions(agentId, newer),
    'agent-controller',
    newer
  );

  expect(vi.mocked(ensureSharedProcess).mock.calls.map((call) => call[0].root)).toEqual([
    superseded,
  ]);
  expect(vi.mocked(ensureSharedProcess).mock.calls[0]![0].restart).toBe(false);
  // Restarted from this build, so it no longer opens the connection its saved
  // config names: binding to that would name something that never returns.
  expect(vi.mocked(ensureSharedProcess).mock.calls[0]![0].config.roomConnection).toEqual({
    connectionId: 'agent-controller',
  });
});

// The sweep reads every session on the machine and only then asks whether each
// one belongs to this agent, so a directory left by an older build — naming a
// provider that no longer exists — used to abort the call and take auto-start
// down for an agent that had nothing to do with it.
it('steps over a neighbour whose saved config no longer parses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-stale-'));
  roots.push(root);
  paths.root = root;
  supervisors.clear();
  vi.mocked(ensureSharedProcess).mockClear();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const agentId = randomUUID();

  // A provider this build has never heard of: exactly what `fde4e217` left on
  // disk for anyone who had a gemini/droid/amp agent before it was removed.
  const stale = template(root);
  stale.session = { ...stale.session, sessionId: 'stale-session', agentId: randomUUID() };
  await mkdir(join(root, 'stale'), { recursive: true });
  await writeFile(
    join(root, 'stale', 'config.json'),
    JSON.stringify({ ...stale, start: { ...stale.start, provider: 'gemini' } })
  );
  // And one that is not even JSON, which must not be fatal either.
  await mkdir(join(root, 'corrupt'), { recursive: true });
  await writeFile(join(root, 'corrupt', 'config.json'), '{ truncated');

  const mine = template(root);
  mine.session = { ...mine.session, sessionId: 'my-session', agentId };
  mine.start.input.sessionId = 'my-session';
  await mkdir(join(root, 'mine'), { recursive: true });
  await writeFile(join(root, 'mine', 'config.json'), JSON.stringify(mine));
  supervisors.set(join(root, 'mine'), { build: '/host/shared-host-old.mjs' });

  const newer = { build: '/host/shared-host-new.mjs', start: vi.fn(), stop: vi.fn(), links: null };
  await expect(
    replaceSupersededSessions(await supersededSessions(agentId, newer), 'agent-controller', newer)
  ).resolves.toBeUndefined();

  // This agent's own session is still picked up, which is the whole point.
  expect(vi.mocked(ensureSharedProcess).mock.calls.map((call) => call[0].root)).toEqual([
    join(root, 'mine'),
  ]);
  // Skipped, but never in silence.
  expect(warn.mock.calls.map(String).join('\n')).toContain('stale');
  warn.mockRestore();
});

it('hands a session it has just created the event that created it', async () => {
  // Nothing else carries that message: the session has no connection of its
  // own, and it is being started precisely because somebody addressed the room.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-first-event-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const hosts = sessionHosts();
  const started: { sessionId: string; parked: unknown[] }[] = [];
  vi.mocked(ensureSharedProcess).mockImplementation(
    async ({ root: sessionRoot, config: launched }) => {
      // Parked in the watcher's journal before the session is started, so a
      // watcher that dies here still has the event to hand over.
      started.push({
        sessionId: launched.session.sessionId,
        parked: (await SharedWatchAssignments.open(root)).pending(),
      });
      return hosts.start(sessionRoot);
    }
  );

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
    await eventually(() => settled(root));
  } finally {
    abort.abort();
    await run;
  }

  const [assigned] = (await SharedWatchAssignments.open(root)).sessions();
  expect(started.map((entry) => entry.sessionId)).toEqual([assigned!.session.sessionId]);
  expect(started[0]!.parked).toMatchObject([
    { sequence: 1, roomId: 'room', messageId: 'message-1' },
  ]);
  expect(hosts.to(join(root, assigned!.session.sessionId))).toMatchObject([
    {
      type: 'room',
      handoff: {
        sequence: 1,
        roomId: 'room',
        messageId: 'message-1',
        event: { type: 'message', payload: { message_id: 'message-1' } },
      },
    },
  ]);
});

it('holds a room nothing can take while starting sessions is off, and delivers once it is on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-held-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  await stopSpawning(root);
  const { supervision } = sessionHosts();
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
    expect((await SharedWatchAssignments.open(root)).pending()).toMatchObject([
      { sequence: 1, roomId: 'room', messageId: 'message-1', spawning: false },
    ]);
    expect(ensureSharedProcess).not.toHaveBeenCalled();

    await writeFlags(root, { enabled: true, spawn: true });
    await eventually(() => vi.mocked(ensureSharedProcess).mock.calls.length >= 1);
    await eventually(() => settled(root));
  } finally {
    abort.abort();
    await run;
  }
  const journal = await SharedWatchAssignments.open(root);
  expect(journal.pending()).toEqual([]);
  expect(journal.sessions()).toHaveLength(1);
});

it('keeps a held event, content and all, across a controller restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-held-restart-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  await stopSpawning(root);
  const hosts = sessionHosts();
  const { supervision } = hosts;
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const first = new AbortController();
  const running = runSharedWatcher(root, config, first.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
  } finally {
    first.abort();
    await running;
  }

  await writeFlags(root, { enabled: true, spawn: true });
  const second = new AbortController();
  const restarted = runSharedWatcher(root, config, second.signal, supervision);
  try {
    await eventually(() => hosts.requests.length >= 1);
    await eventually(() => settled(root));
  } finally {
    second.abort();
    await restarted;
  }
  const [assigned] = (await SharedWatchAssignments.open(root)).sessions();
  expect(hosts.to(join(root, assigned!.session.sessionId))).toMatchObject([
    {
      type: 'room',
      handoff: { messageId: 'message-1', event: { payload: { body: 'Run the check' } } },
    },
  ]);
});

it('starts the session serving a room again when its host has gone, instead of a second one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-revive-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const owner = await existing(root, config);
  await assignTo(root, config, 1, 'room', owner.sessionId);
  const started: string[] = [];
  const hosts = sessionHosts();
  vi.mocked(ensureSharedProcess).mockImplementation(
    async ({ root: sessionRoot, config: launched }) => {
      started.push(launched.session.sessionId);
      return hosts.start(sessionRoot);
    }
  );

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision);
  try {
    await eventually(() => streams.length === 1);
    started.length = 0;
    hosts.exit(owner.sessionRoot);
    await streams[0]!.onEvent!(addressed(2, 'room'));
    await eventually(() => settled(root));
  } finally {
    abort.abort();
    await run;
  }
  expect(started).toEqual([owner.sessionId]);
  expect(hosts.to(owner.sessionRoot)).toMatchObject([
    { type: 'room', handoff: { messageId: 'message-2' } },
  ]);
  expect((await SharedWatchAssignments.open(root)).sessions()).toHaveLength(1);
});

it('gives a room a new session once the one serving it has been stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-stopped-owner-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const owner = await existing(root, config);
  await assignTo(root, config, 1, 'room', owner.sessionId);
  await writeFile(
    join(owner.sessionRoot, 'inbox.jsonl'),
    JSON.stringify({ type: 'stopped' }) + '\n'
  );
  const hosts = sessionHosts();

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(2, 'room'));
    await eventually(() => settled(root));
  } finally {
    abort.abort();
    await run;
  }
  const sessions = (await SharedWatchAssignments.open(root)).sessions();
  expect(sessions).toHaveLength(2);
  expect(sessions.at(-1)!.session.sessionId).not.toBe(owner.sessionId);
  expect(hosts.to(owner.sessionRoot)).toEqual([]);
  expect(hosts.to(join(root, sessions.at(-1)!.session.sessionId))).toMatchObject([
    { type: 'room', handoff: { messageId: 'message-2' } },
  ]);
});

it('passes an approval answer to the session it is for, and only that one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-approvals-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const own = await existing(root, config);
  const otherConfig = structuredClone(config);
  otherConfig.session.agentId = randomUUID();
  const other = await existing(root, otherConfig);
  const hosts = sessionHosts();
  // Both running, so what keeps the other agent's session out is whose it is.
  await hosts.start(own.sessionRoot);
  await hosts.start(other.sessionRoot);
  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision);
  const outcome = (sessionId: string) => ({
    session_id: sessionId,
    request_id: 'permission',
    state: 'answered' as const,
    answer: '0',
    answered_by: '@person:test',
    answered_at: null,
  });
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onApprovalOutcome!(outcome(own.sessionId));
    await streams[0]!.onApprovalOutcome!(outcome(other.sessionId));
    await streams[0]!.onApprovalOutcome!(outcome(randomUUID()));
    expect(hosts.to(own.sessionRoot)).toEqual([{ type: 'approvals' }]);
    expect(hosts.to(other.sessionRoot)).toEqual([]);
    expect(ensureSharedProcess).not.toHaveBeenCalled();
  } finally {
    abort.abort();
    await run;
  }
});

it('hands a relayed command to the session it names, and only if it runs here', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-relay-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const own = await existing(root, config);
  const idle = await existing(root, config);
  const otherConfig = structuredClone(config);
  otherConfig.session.agentId = randomUUID();
  const other = await existing(root, otherConfig);
  const hosts = sessionHosts();
  await hosts.start(own.sessionRoot);
  await hosts.start(other.sessionRoot);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision);
  const command = (sessionId: string) => ({ sessionId, commandId: `command-${sessionId}` });
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onSessionCommand!(command(own.sessionId));
    await streams[0]!.onSessionCommand!(command(other.sessionId));
    // This agent's, but with nothing running it: dropped and said, not started.
    await streams[0]!.onSessionCommand!(command(idle.sessionId));
    expect(hosts.to(own.sessionRoot)).toEqual([
      { type: 'command', command: command(own.sessionId) },
    ]);
    expect(hosts.to(other.sessionRoot)).toEqual([]);
    expect(hosts.to(idle.sessionRoot)).toEqual([]);
    expect(ensureSharedProcess).not.toHaveBeenCalled();
    const dropped = warn.mock.calls.map((call) => String(call[0]));
    expect(
      dropped.some((line) => line.includes(`Dropped command command-${other.sessionId}`))
    ).toBe(true);
    expect(dropped.some((line) => line.includes(`Dropped command command-${idle.sessionId}`))).toBe(
      true
    );
  } finally {
    abort.abort();
    await run;
  }
});

it('refuses to run without being the parent of its sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-detached-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const detached: Supervision = {
    build: 'build',
    start: async () => {},
    stop: async () => {},
    links: null,
  };
  await expect(
    runSharedWatcher(root, config, new AbortController().signal, detached)
  ).rejects.toThrow('parent of its sessions');
});

it('hands a message to its session over the IPC pipe and releases it once taken', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-ipc-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const hosts = sessionHosts();

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
    await eventually(() => hosts.requests.length === 1);
    await eventually(async () =>
      (await readFile(join(root, 'assignments.jsonl'), 'utf8')).includes('released')
    );
  } finally {
    abort.abort();
    await run;
  }

  expect(hosts.requests.map((entry) => entry.request)).toMatchObject([
    {
      type: 'room',
      handoff: {
        sequence: 1,
        roomId: 'room',
        messageId: 'message-1',
        event: { type: 'message', payload: { body: 'Run the check' } },
      },
    },
  ]);
  const journal = await SharedWatchAssignments.open(root);
  // Released on the host's acknowledgement, so nothing is left to route again.
  expect(journal.pending()).toEqual([]);
  expect(journal.cursor).toBe(1);
});
