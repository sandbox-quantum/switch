import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as runtime from '@sandboxaq/switch-agent-runtime';
import type { AgentBridgeEvent, SwitchEventStreamDeps } from '@sandboxaq/switch-agent-runtime';
import { afterEach, expect, it, vi } from 'vitest';
import type { Handoff } from './handoff';
import { ensureSharedProcess, type Supervision } from './launch';
import { type SessionRequest, SessionLinks } from './session-channel';
import { sharedConfigSchema } from './shared-config';
import {
  stopSupersededSessions,
  runSharedWatcher,
  SharedWatchAssignments,
  supersededSessions,
} from './shared-watcher';
import { clearTakenOver, recordTakenOver } from './taken-over';
import { WatcherControl } from './watcher-tools';

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
/** Every placements map the watcher stated to Switch, in order. */
const published = vi.hoisted(() => [] as Record<string, string>[]);
const placementsRefusal = vi.hoisted(() => ({ error: null as Error | null }));
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
      async replacePlacements(placements: Record<string, string>): Promise<void> {
        published.push(structuredClone(placements));
        if (placementsRefusal.error) throw placementsRefusal.error;
      }
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  streams.length = 0;
  declarations.length = 0;
  published.length = 0;
  placementsRefusal.error = null;
  vi.unstubAllGlobals();
  supervisors.clear();
  vi.mocked(ensureSharedProcess).mockReset();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type HostChild = EventEmitter & {
  connected: boolean;
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
  const answers: { id: number; ok: boolean; value?: unknown; error?: string }[] = [];
  let nextAsk = 0;
  const hosts = {
    links,
    requests,
    drop: false,
    /**
     * When set, each host started fails before it is ready, recording this
     * as why — what a host whose provider CLI is not signed in does.
     */
    fail: null as string | null,
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
      child.connected = true;
      child.send = (message, callback) => {
        callback(null);
        if ((message as { kind: string }).kind === 'answer') {
          answers.push(message as (typeof answers)[number]);
          return true;
        }
        const { id, request } = message as { id: number; request: SessionRequest };
        requests.push({ root, request });
        setImmediate(() => {
          if (hosts.drop) child.emit('exit', null, 'SIGKILL');
          else child.emit('message', { kind: 'reply', id, ok: true, value: null });
        });
        return true;
      };
      children.set(root, child);
      links.attach(root, child as unknown as ChildProcess);
      const failure = hosts.fail;
      if (failure !== null) {
        await mkdir(join(root, 'supervisor'), { recursive: true });
        await writeFile(
          join(root, 'supervisor', 'failure.json'),
          JSON.stringify({ message: failure })
        );
        setImmediate(() => child.emit('exit', 1, null));
        return { created: true };
      }
      child.emit('message', { kind: 'ready' });
      return { created: true };
    },
    /**
     * The host at `root` says which session it runs, then asks its parent, as
     * its MCP server does for a tool call; answers what the watcher said.
     */
    ask: async (
      root: string,
      identity: { agentId: string; sessionId: string },
      ask: { type: 'tools' } | { type: 'tool'; name: string; arguments: Record<string, unknown> }
    ) => {
      const child = children.get(root)!;
      child.emit('message', {
        kind: 'identity',
        identity: { ...identity, hostId: 'host', epoch: 'epoch' },
      });
      const id = nextAsk++;
      child.emit('message', { kind: 'ask', id, ask });
      await eventually(() => answers.some((answer) => answer.id === id));
      return answers.find((answer) => answer.id === id)!;
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
    runSharedWatcher(
      root,
      watchable(root),
      new AbortController().signal,
      supervision,
      new WatcherControl()
    )
  ).resolves.toBeUndefined();
  expect(warning.mock.calls[0]?.[0]).toContain('stood down at 2026-01-01T00:00:00.000Z');

  // Cleared by the explicit restart, and the watcher tries to connect again —
  // failing here only because this test gave it no credentials to read.
  await clearTakenOver(root);
  await expect(
    runSharedWatcher(
      root,
      watchable(root),
      new AbortController().signal,
      supervision,
      new WatcherControl()
    )
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

it('starts no saved session at startup; each waits until it is needed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-lazy-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const saved = structuredClone(config);
  saved.session = { ...saved.session, sessionId: randomUUID() };
  await writeFile(
    join(root, 'assignments.jsonl'),
    JSON.stringify({ sequence: 1, roomId: 'room', messageId: 'first', config: saved }) +
      '\n' +
      JSON.stringify({ handled: 1 }) +
      '\n'
  );
  const { supervision } = sessionHosts();

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision, new WatcherControl());
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ensureSharedProcess).not.toHaveBeenCalled();
  } finally {
    abort.abort();
    await run;
  }
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
  const run = runSharedWatcher(root, config, abort.signal, supervision, new WatcherControl());
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
  const run = runSharedWatcher(root, config, abort.signal, supervision, new WatcherControl());
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
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision, new WatcherControl());
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

it('routes to the session Console moved the room to, and tells Switch where every session is', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-placed-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const placed = await existing(root, config);
  const hosts = sessionHosts();
  const control = new WatcherControl();

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision, control);
  try {
    await eventually(() => streams.length === 1);
    expect(await control.place(placed.sessionId, 'room')).toEqual({
      sessionId: placed.sessionId,
      roomId: 'room',
      previous: null,
      displaced: null,
    });
    expect(published.at(-1)).toEqual({ [placed.sessionId]: 'room' });
    await streams[0]!.onEvent!(addressed(1, 'room'));
    await eventually(() => settled(root));
    // Stated again whenever the stream (re)connects: Switch keeps it in memory only.
    const before = published.length;
    streams[0]!.onConnected!();
    await eventually(() => published.length === before + 1);
    expect(published.at(-1)).toEqual({ [placed.sessionId]: 'room' });
  } finally {
    abort.abort();
    await run;
  }

  expect(hosts.to(placed.sessionRoot)).toMatchObject([
    { type: 'room', handoff: { sequence: 1, roomId: 'room', messageId: 'message-1' } },
  ]);
  // The room was served without the watcher minting a session for it.
  expect((await SharedWatchAssignments.open(root)).sessions()).toEqual([]);
  // And a watcher started again routes where this one did.
  expect(JSON.parse(await readFile(join(root, 'placements.json'), 'utf8'))).toEqual({
    placements: { [placed.sessionId]: 'room' },
  });
});

it('puts a move Console asked for back when Switch refuses it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-place-refused-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const first = await existing(root, config);
  const second = await existing(root, config);
  const hosts = sessionHosts();
  const control = new WatcherControl();
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision, control);
  try {
    await eventually(() => streams.length === 1);
    await control.place(first.sessionId, 'room');
    placementsRefusal.error = new Error('HTTP 403: not a member');
    await expect(control.place(second.sessionId, 'room')).rejects.toThrow('not a member');
    placementsRefusal.error = null;
    await streams[0]!.onEvent!(addressed(1, 'room'));
    await eventually(() => settled(root));
    await expect(control.place(randomUUID(), 'room')).rejects.toThrow('not one of this agent');
  } finally {
    abort.abort();
    await run;
  }
  expect(hosts.to(first.sessionRoot)).toMatchObject([{ type: 'room' }]);
  expect(hosts.to(second.sessionRoot)).toEqual([]);
  await expect(control.place(first.sessionId, 'room')).rejects.toThrow('not running');
});

/** A Switch answering the operation list and `connect_to_room`, refusing when told to. */
function switchOps(refuse: { connect: boolean }) {
  const calls: { path: string; headers: Record<string, string>; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    calls.push({
      path,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    });
    if (path.endsWith('/ops'))
      return Response.json({
        operations: {
          connect_to_room: { description: 'Connect.', input_schema: { type: 'object' } },
          post_message: { description: 'Post.', input_schema: { type: 'object' } },
        },
      });
    if (path.endsWith('/ops/connect_to_room'))
      return refuse.connect
        ? new Response('not a member of that room', { status: 403 })
        : Response.json({ result: { room_id: 'room', warning: null } });
    return Response.json({ result: 'posted' });
  });
  return calls;
}

it('answers its sessions’ tool calls as the calling session, placing the room it connects to', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-tools-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const earlier = await existing(root, config);
  const caller = await existing(root, config);
  await assignTo(root, config, 1, 'room', earlier.sessionId);
  const hosts = sessionHosts();
  await hosts.start(caller.sessionRoot);
  const refuse = { connect: false };
  const calls = switchOps(refuse);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const identity = { agentId: config.session.agentId, sessionId: caller.sessionId };

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision, new WatcherControl());
  try {
    await eventually(() => streams.length === 1);
    const tools = await hosts.ask(caller.sessionRoot, identity, { type: 'tools' });
    expect((tools.value as { name: string }[]).map((tool) => tool.name)).toEqual([
      'connect_to_room',
      'post_message',
      'download_attachment',
      'send_attachment',
    ]);

    // Refused by Switch: the room stays with the session that had it.
    refuse.connect = true;
    const refused = await hosts.ask(caller.sessionRoot, identity, {
      type: 'tool',
      name: 'connect_to_room',
      arguments: { room_id: 'room' },
    });
    expect(refused.value).toMatchObject({ isError: true });
    expect(published).toEqual([]);

    refuse.connect = false;
    const connected = await hosts.ask(caller.sessionRoot, identity, {
      type: 'tool',
      name: 'connect_to_room',
      arguments: { room_id: 'room' },
    });
    const result = connected.value as {
      content: { text: string }[];
      structuredContent: { warning: string };
    };
    // The session it took the room from is named, in words the agent can pass on.
    expect(result.structuredContent.warning).toContain(earlier.sessionId);
    expect(result.content.at(-1)!.text).toContain('no longer receives the room');
    expect(published.at(-1)).toEqual({ [caller.sessionId]: 'room' });

    await streams[0]!.onEvent!(addressed(2, 'room'));
    await eventually(() => settled(root));
  } finally {
    abort.abort();
    await run;
  }
  const connect = calls.filter((call) => call.path.endsWith('/ops/connect_to_room')).at(-1)!;
  expect(connect.headers).toMatchObject({
    Authorization: 'Bearer placeholder-token',
    'X-Switch-Connection-Id': 'watcher',
    'X-Switch-Session-Id': caller.sessionId,
    'X-Switch-Session-Host-Id': 'host',
    'X-Switch-Session-Epoch': 'epoch',
  });
  expect(hosts.to(caller.sessionRoot)).toMatchObject([
    { type: 'room', handoff: { messageId: 'message-2' } },
  ]);
  expect(hosts.to(earlier.sessionRoot)).toEqual([]);
});

it('forgets a room another connection took over, and a session that was stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-released-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  await stopSpawning(root);
  const taken = await existing(root, config);
  const stopping = await existing(root, config);
  await assignTo(root, config, 1, 'room', taken.sessionId);
  await assignTo(root, config, 2, 'other', stopping.sessionId);
  const hosts = sessionHosts();
  await hosts.start(stopping.sessionRoot);
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision, new WatcherControl());
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onRoomReleased!({ roomId: 'room', sessionId: taken.sessionId });
    expect(published.at(-1)).toEqual({ [stopping.sessionId]: 'other' });

    // With nothing placed there and starting sessions off, the room's message waits.
    await streams[0]!.onEvent!(addressed(3, 'room'));
    expect((await SharedWatchAssignments.open(root)).pending()).toMatchObject([
      { roomId: 'room', messageId: 'message-3' },
    ]);
    expect(hosts.to(taken.sessionRoot)).toEqual([]);

    // A session that exits having been stopped gives its room up.
    await hosts
      .ask(
        stopping.sessionRoot,
        { agentId: config.session.agentId, sessionId: stopping.sessionId },
        { type: 'tools' }
      )
      .catch(() => null);
    await writeFile(
      join(stopping.sessionRoot, 'inbox.jsonl'),
      JSON.stringify({ type: 'stopped' }) + '\n'
    );
    hosts.exit(stopping.sessionRoot);
    await eventually(
      () => published.at(-1) !== undefined && Object.keys(published.at(-1)!).length === 0
    );
  } finally {
    abort.abort();
    await run;
  }
  expect(JSON.parse(await readFile(join(root, 'placements.json'), 'utf8'))).toEqual({
    placements: {},
  });
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
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision, new WatcherControl());
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
  await stopSupersededSessions(await supersededSessions(agentId, newer), newer);

  // Stopped, and left to start under this build when it is next needed.
  expect(vi.mocked(newer.stop).mock.calls.map(([root]) => root)).toEqual([superseded]);
  expect(ensureSharedProcess).not.toHaveBeenCalled();
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
    stopSupersededSessions(await supersededSessions(agentId, newer), newer)
  ).resolves.toBeUndefined();

  // This agent's own session is still picked up, which is the whole point.
  expect(newer.stop.mock.calls.map(([stopped]) => stopped)).toEqual([join(root, 'mine')]);
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
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision, new WatcherControl());
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
  const run = runSharedWatcher(root, config, abort.signal, supervision, new WatcherControl());
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
  const running = runSharedWatcher(root, config, first.signal, supervision, new WatcherControl());
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
  } finally {
    first.abort();
    await running;
  }

  await writeFlags(root, { enabled: true, spawn: true });
  const second = new AbortController();
  const restarted = runSharedWatcher(
    root,
    config,
    second.signal,
    supervision,
    new WatcherControl()
  );
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
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision, new WatcherControl());
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
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision, new WatcherControl());
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
  // The room is the new session's now, and Switch was told.
  expect(published.at(-1)).toEqual({ [sessions.at(-1)!.session.sessionId]: 'room' });
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
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision, new WatcherControl());
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
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision, new WatcherControl());
  const command = (sessionId: string) => ({ sessionId, commandId: `command-${sessionId}` });
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onSessionCommand!(command(own.sessionId));
    await streams[0]!.onSessionCommand!(command(other.sessionId));
    // This agent's, but with nothing running it: dropped and said, not started.
    await streams[0]!.onSessionCommand!(command(idle.sessionId));
    expect(hosts.to(own.sessionRoot)).toEqual([
      { type: 'command', command: command(own.sessionId), requesterName: null },
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
    runSharedWatcher(root, config, new AbortController().signal, detached, new WatcherControl())
  ).rejects.toThrow('parent of its sessions');
});

it('hands a message to its session over the IPC pipe and releases it once taken', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-ipc-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const hosts = sessionHosts();

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision, new WatcherControl());
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

it('reports its connection and placements as they change, and why it stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-health-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const placed = await existing(root, config);
  const hosts = sessionHosts();
  const control = new WatcherControl();
  const heard: { state: string; detail: string | null; placements: Record<string, string> }[] = [];
  control.onHealth(({ state, detail, placements }) => heard.push({ state, detail, placements }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const run = runSharedWatcher(
    root,
    config,
    new AbortController().signal,
    hosts.supervision,
    control
  );
  await eventually(() => streams.length === 1);
  expect(control.health()).toMatchObject({ state: 'connecting', placements: {} });
  streams[0]!.onConnected!();
  await control.place(placed.sessionId, 'room');
  streams[0]!.onDisconnected!({ error: 'HTTP 502: bad gateway' });
  streams[0]!.onConnected!();
  streams[0]!.onEvicted({ code: 'taken_over', reason: 'another client attached', roomId: null });
  await run;

  expect(heard).toEqual([
    { state: 'connecting', detail: null, placements: {} },
    { state: 'connected', detail: null, placements: {} },
    { state: 'connected', detail: null, placements: { [placed.sessionId]: 'room' } },
    {
      state: 'disconnected',
      detail: 'HTTP 502: bad gateway',
      placements: { [placed.sessionId]: 'room' },
    },
    { state: 'connected', detail: null, placements: { [placed.sessionId]: 'room' } },
    { state: 'taken-over', detail: 'another client attached', placements: {} },
  ]);
});

it('reports a room connection that is turned off, and a watcher that failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-health-off-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const hosts = sessionHosts();
  const control = new WatcherControl();

  const run = runSharedWatcher(
    root,
    config,
    new AbortController().signal,
    hosts.supervision,
    control
  );
  await eventually(() => streams.length === 1);
  await writeFlags(root, { enabled: false, spawn: false });
  await run;
  expect(control.health()).toMatchObject({ state: 'disabled', detail: null, placements: {} });

  await writeFlags(root, { enabled: true, spawn: true });
  await rm(join(root, 'credentials.json'));
  await expect(
    runSharedWatcher(root, config, new AbortController().signal, hosts.supervision, control)
  ).rejects.toThrow('credentials.json');
  expect(control.health().state).toBe('not-running');
  expect(control.health().detail).toContain('credentials.json');
});

/** Answers the Switch operations the watcher calls as a session, recording each. */
function switchOperations(answers: { owner: string | null; refuseTargeted?: boolean }) {
  const calls: { name: string; body: Record<string, unknown>; session: string | null }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const name = String(url).split('/ops/')[1] ?? '';
    const headers = init.headers as Record<string, string>;
    calls.push({
      name,
      body: JSON.parse(String(init.body ?? '{}')),
      session: headers['X-Switch-Session-Id'] ?? null,
    });
    if (name === 'get_agent_detail')
      return new Response(JSON.stringify({ result: { owner_name: answers.owner } }));
    if (name === 'send_targeted_message' && answers.refuseTargeted)
      return new Response('Targets not in room: ada', { status: 400 });
    return new Response(JSON.stringify({ result: { event_id: 'posted' } }));
  });
  return calls;
}

const SIGN_IN = 'Sign in on the execution machine with claude auth login.';

it('stops starting a session whose host failed, keeps its message, and tells its owner once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-failed-start-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const hosts = sessionHosts();
  hosts.fail = SIGN_IN;
  const calls = switchOperations({ owner: 'ada' });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision, new WatcherControl());
  try {
    await eventually(() => streams.length === 1);
    const first = addressed(1, 'room');
    (first.payload as { thread_id?: string }).thread_id = 'thread-root';
    const started = Date.now();
    await streams[0]!.onEvent!(first);
    await eventually(() => calls.some((call) => call.name === 'send_targeted_message'));
    // Told at once rather than after the wait for a host to come up.
    expect(Date.now() - started).toBeLessThan(5000);
    const sessionId = placementsOf(published).room!;
    expect(calls.map((call) => call.name)).toEqual(['get_agent_detail', 'send_targeted_message']);
    expect(calls[1]).toEqual({
      name: 'send_targeted_message',
      session: sessionId,
      body: {
        body: `I couldn't start a session, and it needs you to fix it: ${SIGN_IN} Then address me again.`,
        target_names: ['ada'],
        thread_id: 'thread-root',
      },
    });
    // No retry loop: nothing starts the host again on its own.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(vi.mocked(ensureSharedProcess)).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.some((call) => String(call[0]).includes(SIGN_IN))).toBe(true);

    // A later message tries once more; the same failure is not announced again.
    await streams[0]!.onEvent!(addressed(2, 'room'));
    await eventually(() => vi.mocked(ensureSharedProcess).mock.calls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(vi.mocked(ensureSharedProcess)).toHaveBeenCalledTimes(2);
    expect(calls.filter((call) => call.name === 'send_targeted_message')).toHaveLength(1);

    // Both messages are still owed.
    expect((await SharedWatchAssignments.open(root)).pending().map((e) => e.messageId)).toEqual([
      'message-1',
      'message-2',
    ]);

    // Started from Console once it is fixed: the waiting messages go to it.
    hosts.fail = null;
    await hosts.start(join(root, sessionId));
    await eventually(() => settled(root));
    expect(
      hosts.to(join(root, sessionId)).map((request) => (request as { handoff: Handoff }).handoff)
    ).toMatchObject([{ messageId: 'message-1' }, { messageId: 'message-2' }]);
  } finally {
    abort.abort();
    await run;
  }
});

it('tells the room without addressing anyone when the owner cannot be addressed, and survives a refused post', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-failed-owner-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const hosts = sessionHosts();
  hosts.fail = SIGN_IN;
  const calls = switchOperations({ owner: 'ada', refuseTargeted: true });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, hosts.supervision, new WatcherControl());
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
    await eventually(() => calls.some((call) => call.name === 'post_message'));
    expect(calls.find((call) => call.name === 'post_message')!.body).toEqual({
      body: `I couldn't start a session, and my owner (ada) needs to fix it: ${SIGN_IN} Then address me again.`,
    });
    expect(warn.mock.calls.some((call) => String(call[0]).includes('Targets not in room'))).toBe(
      true
    );

    // A different failure is news, and a post Switch refuses is logged, not fatal.
    hosts.fail = 'The provider executable is missing.';
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
    await streams[0]!.onEvent!(addressed(2, 'room'));
    await eventually(() =>
      error.mock.calls.some((call) =>
        String(call[0]).includes('Could not tell room room that session')
      )
    );
    expect(streams).toHaveLength(1);
  } finally {
    abort.abort();
    await run;
  }
});

/** The last placements map the watcher stated to Switch, room → session. */
function placementsOf(maps: Record<string, string>[]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(maps.at(-1) ?? {}).map(([session, room]) => [room, session])
  );
}
