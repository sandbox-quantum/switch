import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as runtime from '@sandboxaq/switch-agent-runtime-box';
import type { AgentBridgeEvent, SwitchEventStreamDeps } from '@sandboxaq/switch-agent-runtime-box';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compactAssignments,
  MAX_HOST_RESTARTS,
  type OpenAgentStream,
  stopSupersededSessions,
  openSwitchStream,
  runAgentHost,
  AgentHostAssignments,
  definitionChanged,
  supersededSessions,
  withDefinitionOf,
} from './agent-host';
import type { AgentStreamDeps } from './agent-host';
import { BoxValve } from './box-valve';
import type { Handoff } from './handoff';
import { ensureSharedProcess, type Supervision } from './launch';
import {
  RESET_WHILE_WAITING_MESSAGE,
  RoomWaitList,
  STOPPED_WAITING_MESSAGE,
  WAITING_FOR_ROOM_MESSAGE,
} from './room-wait';
import { type SessionRequest, SessionLinks } from './session-channel';
import type * as sessionServices from './session-services';
import { sharedConfigSchema } from './shared-config';
import { keptLine, SESSION_CLOSED_MESSAGE, START_LET_GO_MESSAGE } from './start-failure';
import { clearTakenOver, recordTakenOver } from './taken-over';
import { SESSION_STARTING_MESSAGE, WatcherControl } from './watcher-tools';

const paths = vi.hoisted(() => ({ root: '' }));
const supervisors = vi.hoisted(() => new Map<string, { build: unknown }>());
// Longer than `eventually` waits, so a slow machine fails on what it waited for, not the clock.
vi.setConfig({ testTimeout: 20_000 });

vi.mock('./launch', () => ({
  sharedSessionRoot: (id: string) => join(paths.root, id),
  sharedSessionsBase: () => paths.root,
  liveSupervisor: (root: string) => Promise.resolve(supervisors.get(root) ?? null),
  ensureSharedProcess: vi.fn(),
}));
/** The shape of the agent's grants as the watcher reads them; null reads as unknown. */
const grantsNow = vi.hoisted(() => ({ shape: null as string | null }));
vi.mock('./session-services', async (importOriginal) => ({
  ...(await importOriginal<typeof sessionServices>()),
  GRANTS_CHECK_MS: 20,
  currentServicesShape: async () => grantsNow.shape,
}));
/** What each session's journal says about its turns, by session id; none means no journal. */
const journals = vi.hoisted(() => new Map<string, string[]>());
vi.mock('./journal-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./journal-snapshot')>()),
  readJournalSnapshot: async (sessionId: string) => {
    const statuses = journals.get(sessionId);
    if (!statuses) throw new Error('no journal');
    return { turns: statuses.map((status, i) => ({ turnId: `turn-${i}`, status })) };
  },
}));
/** Whether F1's ceiling lets a new session start. */
const valve = vi.hoisted(() => ({ admit: true, asked: 0, settled: 0 }));
vi.mock('./memory-pressure', async (importOriginal) => {
  const original = await importOriginal<typeof import('./memory-pressure')>();
  return {
    ...original,
    pressureValve: {
      lastRefusal: '',
      register: () => () => {},
      registerAwake: () => () => {},
      watch: () => () => {},
      admit: async () => {
        valve.asked++;
        return valve.admit;
      },
      settle: () => {
        valve.settled++;
      },
    },
  };
});
const streams = vi.hoisted(() => [] as AgentStreamDeps[]);
const declarations = vi.hoisted(() => [] as boolean[]);
/** Every placements map the watcher stated to Switch, in order. */
const published = vi.hoisted(() => [] as Record<string, string>[]);
const placementsRefusal = vi.hoisted(() => ({
  error: null as Error | null,
  refusedRooms: [] as string[],
}));
vi.mock('@sandboxaq/switch-agent-runtime-box', async (importOriginal) => {
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
      async replacePlacements(
        placements: Record<string, string>
      ): Promise<{ refusedRooms: string[] }> {
        published.push(structuredClone(placements));
        if (placementsRefusal.error) throw placementsRefusal.error;
        return { refusedRooms: placementsRefusal.refusedRooms };
      }
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  journals.clear();
  valve.admit = true;
  valve.asked = 0;
  valve.settled = 0;
  streams.length = 0;
  declarations.length = 0;
  published.length = 0;
  placementsRefusal.error = null;
  placementsRefusal.refusedRooms = [];
  vi.useRealTimers();
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
    /** The kind the failing host records beside its message, if any. */
    failKind: null as 'no_login' | 'setup' | null,
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
          JSON.stringify({ message: failure, ...(hosts.failKind ? { kind: hosts.failKind } : {}) })
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
    /** The host at `root` says whether it is in the middle of a turn. */
    busy: (root: string, busy: boolean) =>
      children.get(root)?.emit('message', {
        kind: 'busy',
        busy,
        reasons: busy ? [{ kind: 'turn_running', count: 1 }] : [],
      }),
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
    const opened = await AgentHostAssignments.open(root);
    const first = await opened.assign(template, event);
    await opened.handled(event.sequence);
    const restarted = await AgentHostAssignments.open(root);
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
    runAgentHost(
      root,
      watchable(root),
      new AbortController().signal,
      supervision,
      new WatcherControl(),
      openSwitchStream
    )
  ).resolves.toBeUndefined();
  expect(warning.mock.calls[0]?.[0]).toContain('stood down at 2026-01-01T00:00:00.000Z');

  // Cleared by the explicit restart, and the watcher tries to connect again —
  // failing here only because this test gave it no credentials to read.
  await clearTakenOver(root);
  await expect(
    runAgentHost(
      root,
      watchable(root),
      new AbortController().signal,
      supervision,
      new WatcherControl(),
      openSwitchStream
    )
  ).rejects.toThrow('credentials.json');
});

describe('the owner lock after a crash', () => {
  // A container restarting gives the new controller the same low process id
  // as the one that crashed, so its own id is in the lock the old one left.
  it('takes over a lock left by an earlier process that had this id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-reused-pid-'));
    roots.push(root);
    paths.root = root;
    await writeFlags(root, { enabled: true, spawn: true });
    await writeFile(
      join(root, 'shared-owner.lock'),
      JSON.stringify({ pid: process.pid, token: 'left-by-the-process-before' })
    );
    const { supervision } = sessionHosts();
    // Past the lock: it fails only on the credentials this test gave it none of.
    await expect(
      runAgentHost(
        root,
        watchable(root),
        new AbortController().signal,
        supervision,
        new WatcherControl(),
        openSwitchStream
      )
    ).rejects.toThrow('credentials.json');
  });

  it('takes over a lock with this id and no token, as an old controller wrote it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-reused-pid-no-token-'));
    roots.push(root);
    paths.root = root;
    await writeFlags(root, { enabled: true, spawn: true });
    await writeFile(join(root, 'shared-owner.lock'), JSON.stringify({ pid: process.pid }));
    const { supervision } = sessionHosts();
    await expect(
      runAgentHost(
        root,
        watchable(root),
        new AbortController().signal,
        supervision,
        new WatcherControl(),
        openSwitchStream
      )
    ).rejects.toThrow('credentials.json');
  });

  it('still refuses a lock held by another live process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-live-owner-'));
    roots.push(root);
    paths.root = root;
    await writeFlags(root, { enabled: true, spawn: true });
    await writeFile(
      join(root, 'shared-owner.lock'),
      JSON.stringify({ pid: process.ppid, token: 'the-parent-holds-it' })
    );
    const { supervision } = sessionHosts();
    await expect(
      runAgentHost(
        root,
        watchable(root),
        new AbortController().signal,
        supervision,
        new WatcherControl(),
        openSwitchStream
      )
    ).rejects.toThrow('The shared SDK watcher is already running.');
  });

  it('takes a lock left by an earlier process whose id a later one holds now', async () => {
    // Box A, 27 Oct: after a restart a saved id can name the controller or a
    // sibling host. A lock written before that process started is stale.
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-stale-owner-'));
    roots.push(root);
    paths.root = root;
    const config = await spawning(root);
    const lock = join(root, 'shared-owner.lock');
    await writeFile(lock, JSON.stringify({ pid: process.ppid, token: 'left-four-days-ago' }));
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 3600 * 1000);
    await utimes(lock, fourDaysAgo, fourDaysAgo);
    const { supervision } = sessionHosts();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = new AbortController();
    const running = runAgentHost(
      root,
      config,
      stop.signal,
      supervision,
      new WatcherControl(),
      openSwitchStream
    );
    try {
      await eventually(async () => {
        const text = await readFile(lock, 'utf8').catch(() => '');
        return text !== '' && !text.includes('left-four-days-ago');
      });
    } finally {
      stop.abort();
      await running;
    }
    expect(() => process.kill(process.ppid, 0)).not.toThrow();
  });

  it('takes a fresh lock naming this process with a token it never wrote', async () => {
    // After a container restart the controller gets the same low id again, and
    // the earlier one's lock can be newer than this process's start check
    // allows for: it is judged alive, but this process never wrote it.
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-own-id-foreign-token-'));
    roots.push(root);
    paths.root = root;
    const config = await spawning(root);
    const lock = join(root, 'shared-owner.lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'an-earlier-process' }));
    const { supervision } = sessionHosts();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = new AbortController();
    const running = runAgentHost(
      root,
      config,
      stop.signal,
      supervision,
      new WatcherControl(),
      openSwitchStream
    );
    try {
      await eventually(async () => {
        const text = await readFile(lock, 'utf8').catch(() => '');
        return text !== '' && !text.includes('an-earlier-process');
      });
    } finally {
      stop.abort();
      await running;
    }
  });

  it('still refuses a second watcher in this process while the first runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-same-process-'));
    roots.push(root);
    paths.root = root;
    const config = await spawning(root);
    const { supervision } = sessionHosts();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = new AbortController();
    const running = runAgentHost(
      root,
      config,
      first.signal,
      supervision,
      new WatcherControl(),
      openSwitchStream
    );
    try {
      await eventually(() => streams.length === 1);
      await expect(
        runAgentHost(
          root,
          config,
          new AbortController().signal,
          supervision,
          new WatcherControl(),
          openSwitchStream
        )
      ).rejects.toThrow('The shared SDK watcher is already running.');
    } finally {
      first.abort();
      await running;
    }
    // Released on the way out, so the next start in this process takes it.
    await expect(readFile(join(root, 'shared-owner.lock'), 'utf8')).rejects.toThrow('ENOENT');
  });
});

it('asks again for an event it assigned but died before routing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-unrouted-'));
  roots.push(root);
  paths.root = root;
  const config = template(root);
  const assignments = await AgentHostAssignments.open(root);
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

  const restarted = await AgentHostAssignments.open(root);
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
  const older = await AgentHostAssignments.open(root);
  for (const [sequence, roomId] of [
    [4, 'room'],
    [6, 'other'],
    [7, 'third'],
  ] as const)
    await older.assign(config, { sequence, roomId, messageId: `m${sequence}` });

  // Six, because the watcher only assigns the next event once the one before it
  // has been routed — so only the last record is still owed.
  expect((await AgentHostAssignments.open(root)).cursor).toBe(6);
});

it('resumes at the server head after its numbering restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-restart-'));
  roots.push(root);
  paths.root = root;
  const config = template(root);
  const assignments = await AgentHostAssignments.open(root);
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
  const reloaded = await AgentHostAssignments.open(root);
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
/** Up to 10 s: the watcher sees a rewritten file through fs events, which a loaded machine delivers late. */
async function eventually(reached: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (await reached()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The watcher never reached the state this test was waiting for.');
}

/**
 * Whether every event the watcher parked has been taken by its session. Read
 * from a copy: opening the live journal a second time would clear a
 * compaction the watcher has under way (a journal has one owner).
 */
async function settled(root: string): Promise<boolean> {
  const copy = await mkdtemp(join(tmpdir(), 'journal-copy-'));
  try {
    await writeFile(
      join(copy, 'assignments.jsonl'),
      await readFile(join(root, 'assignments.jsonl'), 'utf8')
    );
    return (await AgentHostAssignments.open(copy)).pending().length === 0;
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
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

/** The same event, as asked in a thread. */
const threaded = (event: AgentBridgeEvent, threadId: string): AgentBridgeEvent => ({
  ...event,
  payload: { ...event.payload, thread_id: threadId } as AgentBridgeEvent['payload'],
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
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    supervision,
    new WatcherControl(),
    openSwitchStream
  );
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
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    supervision,
    new WatcherControl(),
    openSwitchStream
  );
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

  const journal = await AgentHostAssignments.open(root);
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
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    supervision,
    new WatcherControl(),
    openSwitchStream
  );
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

  const journal = await AgentHostAssignments.open(root);
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
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
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
  const journal = await AgentHostAssignments.open(root);
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
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    control,
    openSwitchStream
  );
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
  expect((await AgentHostAssignments.open(root)).sessions()).toEqual([]);
  // And a watcher started again routes where this one did.
  expect(JSON.parse(await readFile(join(root, 'placements.json'), 'utf8'))).toEqual({
    placements: { [placed.sessionId]: 'room' },
  });
});

it('warms a room once: starts its session unasked, and the first message goes to it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-warm-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const hosts = sessionHosts();
  const control = new WatcherControl();

  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    control,
    openSwitchStream
  );
  let warmed: string | null = null;
  try {
    await eventually(() => streams.length === 1);
    warmed = await control.warm('room');
    expect(warmed).not.toBeNull();
    expect(published.at(-1)).toEqual({ [warmed!]: 'room' });
    expect(await control.warm('room')).toBe(warmed);
    await streams[0]!.onEvent!(addressed(1, 'room'));
    await eventually(() => settled(root));
  } finally {
    abort.abort();
    await run;
  }

  expect(
    new Set(
      vi.mocked(ensureSharedProcess).mock.calls.map((call) => call[0].config.session.sessionId)
    )
  ).toEqual(new Set([warmed]));
  expect(hosts.to(join(root, warmed!))).toMatchObject([
    { type: 'room', handoff: { sequence: 1, roomId: 'room', messageId: 'message-1' } },
  ]);
  const journal = await AgentHostAssignments.open(root);
  expect(journal.sessions().map((each) => each.session.sessionId)).toEqual([warmed]);
  expect(journal.cursor).toBe(1);
  await expect(control.warm('room')).rejects.toThrow('not running');
});

it('skips a warm the box has no room for, quietly at info, and answers null', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-warm-full-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const hosts = sessionHosts();
  const control = new WatcherControl();
  valve.admit = false;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    control,
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    expect(await control.warm('room')).toBeNull();
  } finally {
    abort.abort();
    await run;
    valve.admit = true;
  }
  expect(vi.mocked(ensureSharedProcess)).not.toHaveBeenCalled();
  expect(info.mock.calls.some(([line]) => String(line).startsWith('Skipped warming session'))).toBe(
    true
  );
  expect(warn.mock.calls.some(([line]) => /warm/i.test(String(line)))).toBe(false);
});

it('warms nothing while the agent may not start sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-warm-off-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  await stopSpawning(root);
  const hosts = sessionHosts();
  const control = new WatcherControl();

  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    control,
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    expect(await control.warm('room')).toBeNull();
  } finally {
    abort.abort();
    await run;
  }
  expect(vi.mocked(ensureSharedProcess)).not.toHaveBeenCalled();
  expect((await AgentHostAssignments.open(root)).sessions()).toEqual([]);
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
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    control,
    openSwitchStream
  );
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

describe('a room post made while Switch is away', () => {
  /**
   * A Switch that can be away (no process serving: every call fails to
   * connect, as at 07:54:27.186 on box A, when the old Core had stopped and
   * the new one answered only from 07:54:39), and that posts once per key for
   * the agent, as Core's `uq_messages_sender_client_txn` does.
   */
  function restartingSwitch() {
    const state = {
      away: null as null | 'unreachable' | '502' | '409',
      loseAnswer: false,
      refuse: false,
    };
    const posted = new Map<string, string>();
    const keys: (string | undefined)[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/ops'))
        return Response.json({
          operations: {
            connect_to_room: { description: 'Connect.', input_schema: { type: 'object' } },
            post_message: { description: 'Post.', input_schema: { type: 'object' } },
          },
        });
      if (!path.endsWith('/ops/post_message')) return Response.json({ result: null });
      const key = (init.headers as Record<string, string>)['X-Switch-Client-Txn-Id'];
      keys.push(key);
      bodies.push(JSON.parse(String(init.body)));
      // The three ways a call meets a Switch that is away: nothing to connect
      // to, a gateway answering for it, or a restarted Switch that no longer
      // knows the agent's connection.
      if (state.away === 'unreachable') throw new TypeError('fetch failed: connect ECONNREFUSED');
      if (state.away === '502') return new Response('bad gateway', { status: 502 });
      if (state.away === '409')
        return new Response('connection watcher is not open', { status: 409 });
      if (state.refuse) return new Response('agent is not a member of that room', { status: 403 });
      const eventId = (key && posted.get(key)) ?? `event-${posted.size + 1}`;
      if (key) posted.set(key, eventId);
      if (state.loseAnswer) {
        state.loseAnswer = false;
        throw new TypeError('fetch failed: socket hang up');
      }
      return Response.json({ result: { event_id: eventId } });
    });
    return { state, posted, keys, bodies };
  }

  const placedSession = async (prefix: string) => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    paths.root = root;
    const config = await spawning(root);
    const caller = await existing(root, config);
    await writeFile(
      join(root, 'placements.json'),
      JSON.stringify({ placements: { [caller.sessionId]: 'room' } })
    );
    const hosts = sessionHosts();
    await hosts.start(caller.sessionRoot);
    const identity = { agentId: config.session.agentId, sessionId: caller.sessionId };
    return { root, config, caller, hosts, identity };
  };
  const post = (body: string, extra: Record<string, unknown> = {}) => ({
    type: 'tool' as const,
    name: 'post_message',
    arguments: { body, thread_id: 'thread-1', ...extra },
  });

  it.each(['unreachable', '502', '409'] as const)(
    'holds a reply Switch could not take (%s), tells the agent not to resend, and posts it once Switch is back',
    async (away) => {
      const { root, config, caller, hosts, identity } = await placedSession('shared-watch-b62-');
      const switchCore = restartingSwitch();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const abort = new AbortController();
      const run = runAgentHost(
        root,
        config,
        abort.signal,
        hosts.supervision,
        new WatcherControl(),
        openSwitchStream
      );
      try {
        await eventually(() => streams.length === 1);
        // 07:54:27.186: the agent posts its reply while no Switch is serving.
        switchCore.state.away = away;
        const first = await hosts.ask(caller.sessionRoot, identity, post('the reply'));
        expect(first.value).toEqual({
          content: [
            {
              type: 'text',
              text: "Switch is restarting, so your message hasn't reached the room yet. It's held and will be posted as soon as Switch is back. Don't post it again yourself.",
            },
          ],
        });
        // The agent sends it again anyway: still the one held post, not tried again.
        const again = await hosts.ask(caller.sessionRoot, identity, post('the reply'));
        expect(again.value).toEqual(first.value);
        expect(switchCore.keys).toHaveLength(1);
        // 07:54:39: Switch is back, and the agent's connection reopens.
        switchCore.state.away = null;
        streams[0]!.onConnected!();
        await eventually(() => switchCore.posted.size === 1);
      } finally {
        abort.abort();
        await run;
      }
      // Every try went under the one key the watcher chose, from the first.
      expect(switchCore.keys.length).toBeGreaterThanOrEqual(2);
      expect(new Set(switchCore.keys).size).toBe(1);
      expect(switchCore.keys[0]).toMatch(/^reply:[0-9a-f-]{36}$/);
      expect(switchCore.bodies.at(-1)).toEqual({ body: 'the reply', thread_id: 'thread-1' });
      // Logged by key, session and room, never by what it said.
      const lines = [...warn.mock.calls, ...info.mock.calls].map(([line]) => String(line));
      expect(lines.some((line) => line.startsWith(`Holding reply ${switchCore.keys[0]}`))).toBe(
        true
      );
      expect(lines.some((line) => line.startsWith(`Posted held reply ${switchCore.keys[0]}`))).toBe(
        true
      );
      expect(lines.some((line) => line.includes('the reply'))).toBe(false);
    }
  );

  it('posts one copy when Switch made the post but its answer was lost', async () => {
    const { root, config, caller, hosts, identity } = await placedSession('shared-watch-b62-lost-');
    const switchCore = restartingSwitch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const abort = new AbortController();
    const run = runAgentHost(
      root,
      config,
      abort.signal,
      hosts.supervision,
      new WatcherControl(),
      openSwitchStream
    );
    try {
      await eventually(() => streams.length === 1);
      switchCore.state.loseAnswer = true;
      const first = await hosts.ask(caller.sessionRoot, identity, post('the reply'));
      expect(first.value).toMatchObject({ content: [{ text: expect.stringContaining('held') }] });
      streams[0]!.onConnected!();
      await eventually(() => switchCore.keys.length === 2);
    } finally {
      abort.abort();
      await run;
    }
    expect(switchCore.keys[1]).toBe(switchCore.keys[0]);
    expect(switchCore.posted.size).toBe(1);
  });

  it('tells the room a held reply was lost when the watcher before this one stopped holding it', async () => {
    const { root, config, caller, hosts } = await placedSession('shared-watch-b62-restart-');
    const key = 'reply:7f1c0000-0000-4000-8000-000000000001';
    await writeFile(
      join(root, 'held-replies.json'),
      JSON.stringify({
        owed: [
          {
            key,
            sessionId: caller.sessionId,
            roomId: 'room',
            threadId: 'thread-1',
            heldAt: Date.now(),
          },
        ],
      })
    );
    const switchCore = restartingSwitch();
    switchCore.state.away = 'unreachable';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const abort = new AbortController();
    const run = runAgentHost(
      root,
      config,
      abort.signal,
      hosts.supervision,
      new WatcherControl(),
      openSwitchStream
    );
    try {
      await eventually(() => streams.length === 1);
      // Switch answers again: the room is told, once, in the lost reply's thread.
      switchCore.state.away = null;
      streams[0]!.onConnected!();
      await eventually(() => switchCore.posted.size === 1);
      streams[0]!.onConnected!();
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      abort.abort();
      await run;
    }
    expect([...switchCore.posted.keys()]).toEqual([`${key}:lost`]);
    expect(switchCore.bodies.at(-1)).toEqual({
      body: "I wrote a reply while Switch was restarting, but it couldn't be delivered in time and was lost. Please send your message again.",
      thread_id: 'thread-1',
    });
    expect(JSON.parse(await readFile(join(root, 'held-replies.json'), 'utf8')).owed).toEqual([]);
  });

  it("passes Switch's refusal to the agent as before, holding nothing", async () => {
    const { root, config, caller, hosts, identity } = await placedSession('shared-watch-b62-no-');
    const switchCore = restartingSwitch();
    switchCore.state.refuse = true;
    const abort = new AbortController();
    const run = runAgentHost(
      root,
      config,
      abort.signal,
      hosts.supervision,
      new WatcherControl(),
      openSwitchStream
    );
    try {
      await eventually(() => streams.length === 1);
      const refused = await hosts.ask(caller.sessionRoot, identity, post('the reply'));
      expect(refused.value).toMatchObject({
        isError: true,
        content: [{ text: '403: agent is not a member of that room' }],
      });
      streams[0]!.onConnected!();
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      abort.abort();
      await run;
    }
    expect(switchCore.keys).toHaveLength(1);
  });

  it("keys each post itself: an agent's own arguments never set the key", async () => {
    const { root, config, caller, hosts, identity } = await placedSession('shared-watch-b62-key-');
    const switchCore = restartingSwitch();
    const abort = new AbortController();
    const run = runAgentHost(
      root,
      config,
      abort.signal,
      hosts.supervision,
      new WatcherControl(),
      openSwitchStream
    );
    try {
      await eventually(() => streams.length === 1);
      await hosts.ask(
        caller.sessionRoot,
        identity,
        post('one', { client_txn_id: 'reply:someone-elses', 'X-Switch-Client-Txn-Id': 'reply:x' })
      );
      await hosts.ask(caller.sessionRoot, identity, post('two'));
    } finally {
      abort.abort();
      await run;
    }
    // The agent's words go as its arguments, which Switch refuses; the key
    // header is the watcher's own, a new one for each post.
    expect(switchCore.keys).toHaveLength(2);
    expect(switchCore.keys).not.toContain('reply:someone-elses');
    expect(switchCore.keys).not.toContain('reply:x');
    expect(new Set(switchCore.keys).size).toBe(2);
  });
});

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
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
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
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onRoomReleased!({ roomId: 'room', sessionId: taken.sessionId });
    expect(published.at(-1)).toEqual({ [stopping.sessionId]: 'other' });

    // With nothing placed there and starting sessions off, the room's message waits.
    await streams[0]!.onEvent!(addressed(3, 'room'));
    expect((await AgentHostAssignments.open(root)).pending()).toMatchObject([
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
  const assignments = await AgentHostAssignments.open(root);
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
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
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

  const journal = await AgentHostAssignments.open(root);
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

  // A provider this build has never heard of: exactly what an earlier change left on
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
  // An upgrade is a restart nobody in the room asked for: a turn it cuts off still owes the line.
  expect(newer.stop.mock.calls.map(([, options]) => options)).toEqual([{ asked: false }]);
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
        parked: (await AgentHostAssignments.open(root)).pending(),
      });
      return hosts.start(sessionRoot);
    }
  );

  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
    await eventually(() => settled(root));
  } finally {
    abort.abort();
    await run;
  }

  const [assigned] = (await AgentHostAssignments.open(root)).sessions();
  expect(started.map((entry) => entry.sessionId)).toEqual([assigned!.session.sessionId]);
  expect(started[0]!.parked).toMatchObject([
    { sequence: 1, roomId: 'room', messageId: 'message-1' },
  ]);
  // Started because the room addressed the agent, which its host reports.
  expect(vi.mocked(ensureSharedProcess).mock.calls[0]![0].startSource).toBe('room');
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

it('tells the room it is starting a session when its stream leaves that to it, before handing the message over', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-starting-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const hosts = sessionHosts();
  vi.mocked(ensureSharedProcess).mockImplementation(async ({ root: sessionRoot }) =>
    hosts.start(sessionRoot)
  );
  const calls = switchOperations({ owner: 'ada' });
  const opened: SwitchEventStreamDeps[] = [];
  const controllerStream: OpenAgentStream = (deps) => {
    opened.push(deps);
    return {
      announcesSessionStarts: true,
      placementsNameCallRooms: true,
      start: () => {},
      setSpawnCapable: () => {},
      replacePlacements: async (placements) => {
        published.push(structuredClone(placements));
        return { refusedRooms: [] };
      },
    };
  };

  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    controllerStream
  );
  try {
    await eventually(() => opened.length === 1);
    await opened[0]!.onEvent(threaded(addressed(1, 'room'), 'thread-1'));
    await eventually(() => settled(root));
    // A second message for the room it now has a session in says nothing.
    await opened[0]!.onEvent(addressed(2, 'room'));
    await eventually(() => settled(root));
  } finally {
    abort.abort();
    await run;
  }

  const [assigned] = (await AgentHostAssignments.open(root)).sessions();
  const notices = calls.filter((call) => call.name === 'post_message');
  expect(notices).toEqual([
    {
      name: 'post_message',
      body: { body: SESSION_STARTING_MESSAGE, thread_id: 'thread-1' },
      session: assigned!.session.sessionId,
    },
  ]);
  expect(hosts.to(join(root, assigned!.session.sessionId))).toHaveLength(2);
});

it('leaves telling the room to Switch on its own connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-not-starting-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const hosts = sessionHosts();
  vi.mocked(ensureSharedProcess).mockImplementation(async ({ root: sessionRoot }) =>
    hosts.start(sessionRoot)
  );
  const calls = switchOperations({ owner: 'ada' });
  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
    await eventually(() => settled(root));
  } finally {
    abort.abort();
    await run;
  }
  expect(calls.filter((call) => call.name === 'post_message')).toEqual([]);
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
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
    expect((await AgentHostAssignments.open(root)).pending()).toMatchObject([
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
  const journal = await AgentHostAssignments.open(root);
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
  const running = runAgentHost(
    root,
    config,
    first.signal,
    supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
  } finally {
    first.abort();
    await running;
  }

  await writeFlags(root, { enabled: true, spawn: true });
  const second = new AbortController();
  const restarted = runAgentHost(
    root,
    config,
    second.signal,
    supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => hosts.requests.length >= 1);
    await eventually(() => settled(root));
  } finally {
    second.abort();
    await restarted;
  }
  const [assigned] = (await AgentHostAssignments.open(root)).sessions();
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
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
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
  expect((await AgentHostAssignments.open(root)).sessions()).toHaveLength(1);
});

it('takes the model, approval mode, instructions and advanced configuration from the template', () => {
  const root = '/state';
  const edited = watchable(root);
  edited.start.input.model = { id: 'claude-sonnet-4-6', options: { effort: 'high' } };
  edited.start.input.runtimeMode = 'full-access';
  edited.start.input.agentName = 'scout';
  edited.start.input.agentDefinition = {
    description: 'scout',
    prompt: 'Answer in one word.',
    permissionMode: 'plan',
  };
  edited.execution!.context = 'Answer in one word.';
  edited.execution!.codexConfig = 'model_verbosity = "low"\n';
  const saved = watchable(root);
  saved.session = { ...saved.session, agentId: edited.session.agentId, sessionId: 'room-session' };
  saved.start.input.sessionId = 'room-session';
  saved.start.input.model = { id: 'haiku' };
  saved.start.input.resume = { nativeSessionId: 'native' };

  const refreshed = withDefinitionOf(saved, edited);

  expect(definitionChanged(saved, edited)).toBe(true);
  expect(definitionChanged(refreshed, edited)).toBe(false);
  expect(refreshed.start.input).toMatchObject({
    sessionId: 'room-session',
    model: { id: 'claude-sonnet-4-6', options: { effort: 'high' } },
    runtimeMode: 'full-access',
    agentName: 'scout',
    agentDefinition: {
      description: 'scout',
      prompt: 'Answer in one word.',
      permissionMode: 'plan',
    },
    resume: { nativeSessionId: 'native' },
  });
  expect(refreshed.execution).toMatchObject({
    context: 'Answer in one word.',
    codexConfig: 'model_verbosity = "low"\n',
  });
  expect(refreshed.session.sessionId).toBe('room-session');
  delete edited.start.input.model;
  delete edited.start.input.agentName;
  delete edited.start.input.agentDefinition;
  const cleared = withDefinitionOf(refreshed, edited);
  expect(cleared.start.input.model).toBeUndefined();
  expect(cleared.start.input).not.toHaveProperty('agentName');
  expect(cleared.start.input).not.toHaveProperty('agentDefinition');
});

it('gives a session the provider login its agent signs in with now, keeping its own id', () => {
  const root = '/state';
  const controller = watchable(root);
  controller.start.input.env = { CURSOR_API_KEY: 'crsr_given', SWITCHDASH_SESSION_ID: 'watcher' };
  const saved = watchable(root);
  saved.session = {
    ...saved.session,
    agentId: controller.session.agentId,
    sessionId: 'room-session',
  };
  saved.start.input.env = { SWITCHDASH_SESSION_ID: 'room-session', CURSOR_API_KEY: 'crsr_old' };

  const refreshed = withDefinitionOf(saved, controller);

  expect(definitionChanged(saved, controller)).toBe(true);
  expect(refreshed.start.input.env).toEqual({
    CURSOR_API_KEY: 'crsr_given',
    SWITCHDASH_SESSION_ID: 'room-session',
  });
  delete controller.start.input.env.CURSOR_API_KEY;
  expect(withDefinitionOf(refreshed, controller).start.input.env).toEqual({
    SWITCHDASH_SESSION_ID: 'room-session',
  });
});

it('gives a session the credentials and binary of whoever runs its watcher now', () => {
  const root = '/state';
  const controller = watchable(root);
  controller.execution!.credentialsPath = '/data/agents/agent-1/credentials.json';
  controller.execution!.binaryPath = '/usr/local/bin/claude';
  const saved = watchable(root);
  saved.session = {
    ...saved.session,
    agentId: controller.session.agentId,
    sessionId: 'room-session',
  };
  saved.execution!.credentialsPath = '/work/agent/.switch/agents/agent.json';
  delete saved.execution!.binaryPath;

  const refreshed = withDefinitionOf(saved, controller);

  expect(definitionChanged(saved, controller)).toBe(true);
  expect(refreshed.execution).toMatchObject({
    credentialsPath: '/data/agents/agent-1/credentials.json',
    binaryPath: '/usr/local/bin/claude',
  });
});

it('leaves a session that runs as a definition file on disk as the agent it runs as', () => {
  const root = '/state';
  const edited = watchable(root);
  edited.start.input.agentName = 'parent';
  edited.start.input.agentDefinition = { description: 'parent', prompt: 'Lead.' };
  const saved = watchable(root);
  saved.session = {
    ...saved.session,
    agentId: edited.session.agentId,
    sessionId: 'helper-session',
  };
  saved.execution!.agentDefinition = { name: 'helper', path: '.claude/agents/helper.md' };

  const refreshed = withDefinitionOf(saved, edited);

  expect(refreshed.start.input).not.toHaveProperty('agentName');
  expect(refreshed.start.input).not.toHaveProperty('agentDefinition');
  expect(refreshed.execution!.agentDefinition).toEqual({
    name: 'helper',
    path: '.claude/agents/helper.md',
  });
});

it('restarts a room’s session under its agent’s edited definition, resuming the same session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-redefined-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const before = structuredClone(config);
  before.start.input.model = { id: 'haiku' };
  before.execution!.context = 'Old instructions.';
  config.start.input.model = { id: 'claude-sonnet-4-6' };
  config.execution!.context = 'New instructions.';
  await writeFile(join(root, 'config.json'), JSON.stringify(config));
  const stale = await existing(root, before);
  const current = await existing(root, config);
  await assignTo(root, before, 1, 'room', stale.sessionId);
  await assignTo(root, config, 2, 'elsewhere', current.sessionId);
  supervisors.set(stale.sessionRoot, { build: 'build' });
  supervisors.set(current.sessionRoot, { build: 'build' });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const hosts = sessionHosts();
  const stoppedRoots: string[] = [];
  hosts.supervision.stop = async (sessionRoot) => {
    stoppedRoots.push(sessionRoot);
    supervisors.delete(sessionRoot);
  };
  const launched: { sessionId: string; model: unknown; context: unknown }[] = [];
  vi.mocked(ensureSharedProcess).mockImplementation(
    async ({ root: sessionRoot, config: started }) => {
      launched.push({
        sessionId: started.session.sessionId,
        model: started.start.input.model,
        context: started.execution?.context,
      });
      return hosts.start(sessionRoot);
    }
  );

  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(3, 'room'));
    await eventually(() => settled(root));
  } finally {
    abort.abort();
    await run;
  }
  // Only the session saved under the earlier definition was stopped.
  expect(stoppedRoots).toEqual([stale.sessionRoot]);
  expect(warn.mock.calls.map(String).join('\n')).toContain('earlier definition');
  // Started again as the same session, under the current definition.
  expect(launched).toEqual([
    {
      sessionId: stale.sessionId,
      model: { id: 'claude-sonnet-4-6' },
      context: 'New instructions.',
    },
  ]);
  expect(hosts.to(stale.sessionRoot)).toMatchObject([
    { type: 'room', handoff: { messageId: 'message-3' } },
  ]);
});

it('brings live sessions in step with a rewritten definition, each once its turn has ended', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-live-redefined-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const working = await existing(root, config);
  const idle = await existing(root, config);
  await assignTo(root, config, 1, 'room', working.sessionId);
  await assignTo(root, config, 2, 'elsewhere', idle.sessionId);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const hosts = sessionHosts();
  await hosts.start(working.sessionRoot);
  await hosts.start(idle.sessionRoot);
  hosts.busy(working.sessionRoot, true);
  hosts.busy(idle.sessionRoot, false);
  const restarted: { root: string; model: unknown; context: unknown; resuming: boolean }[] = [];
  vi.mocked(ensureSharedProcess).mockImplementation(
    async ({ root: sessionRoot, config: started, resuming }) => {
      restarted.push({
        root: sessionRoot,
        model: started.start.input.model,
        context: started.execution?.context,
        resuming,
      });
      await writeFile(join(sessionRoot, 'config.json'), JSON.stringify(started));
      return { created: false };
    }
  );

  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    const edited = structuredClone(config);
    edited.start.input.model = { id: 'claude-sonnet-4-6' };
    edited.execution!.context = 'New instructions.';
    await writeFile(join(root, 'config.json.next'), JSON.stringify(edited));
    await rename(join(root, 'config.json.next'), join(root, 'config.json'));
    await eventually(() => restarted.length === 1);
    // The session in the middle of a turn is left to finish it.
    expect(restarted).toEqual([
      {
        root: idle.sessionRoot,
        model: { id: 'claude-sonnet-4-6' },
        context: 'New instructions.',
        resuming: true,
      },
    ]);
    hosts.busy(working.sessionRoot, false);
    await eventually(() => restarted.length === 2);
    expect(restarted[1]).toMatchObject({
      root: working.sessionRoot,
      model: { id: 'claude-sonnet-4-6' },
      resuming: true,
    });
  } finally {
    abort.abort();
    await run;
  }
  expect(restarted).toHaveLength(2);
});

it('reports which of its sessions are mid-turn, as their hosts start, go busy, go idle and exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-busy-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const first = await existing(root, config);
  const second = await existing(root, config);
  await assignTo(root, config, 1, 'room', first.sessionId);
  await assignTo(root, config, 2, 'elsewhere', second.sessionId);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const hosts = sessionHosts();
  await hosts.start(first.sessionRoot);
  hosts.busy(first.sessionRoot, false);
  const control = new WatcherControl();
  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    control,
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    expect(control.health().busy).toEqual([]);
    hosts.busy(first.sessionRoot, true);
    expect(control.health().busy).toEqual([first.sessionId]);
    hosts.busy(first.sessionRoot, false);
    expect(control.health().busy).toEqual([]);
    // A host that has not said yet whether it is in a turn is not taken to be idle.
    await hosts.start(second.sessionRoot);
    expect(control.health().busy).toEqual([second.sessionId]);
    hosts.exit(second.sessionRoot);
    expect(control.health().busy).toEqual([]);
  } finally {
    abort.abort();
    await run;
  }
  expect(control.health().busy).toEqual([]);
});

/** Records, as a session's host does as it starts, the shape of the grants it started with. */
async function startedWith(sessionRoot: string, shape: string): Promise<void> {
  await writeFile(join(sessionRoot, 'services.json'), JSON.stringify({ shape }));
}

it('restarts live sessions once a service is granted to their agent, each once its turn has ended', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-regranted-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const working = await existing(root, config);
  const idle = await existing(root, config);
  const unrecorded = await existing(root, config);
  await assignTo(root, config, 1, 'room', working.sessionId);
  await assignTo(root, config, 2, 'elsewhere', idle.sessionId);
  await assignTo(root, config, 3, 'third', unrecorded.sessionId);
  await startedWith(working.sessionRoot, '[]');
  await startedWith(idle.sessionRoot, '[]');
  grantsNow.shape = '[]';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const hosts = sessionHosts();
  for (const session of [working, idle, unrecorded]) await hosts.start(session.sessionRoot);
  hosts.busy(working.sessionRoot, true);
  hosts.busy(idle.sessionRoot, false);
  hosts.busy(unrecorded.sessionRoot, false);
  const restarted: { root: string; resuming: boolean; restart: boolean }[] = [];
  vi.mocked(ensureSharedProcess).mockImplementation(
    async ({ root: sessionRoot, resuming, restart }) => {
      restarted.push({ root: sessionRoot, resuming, restart });
      // The new host records the grants it started with, as `shared-daemon` does.
      await startedWith(sessionRoot, grantsNow.shape!);
      return { created: false };
    }
  );

  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    // Nothing granted or taken away: every check leaves the sessions alone.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(restarted).toEqual([]);
    grantsNow.shape = '[{"service":"google-workspace"}]';
    await eventually(() => restarted.length === 1);
    // The session in the middle of a turn is left to finish it, and one whose
    // host recorded nothing is not restarted on a guess.
    expect(restarted).toEqual([{ root: idle.sessionRoot, resuming: true, restart: true }]);
    hosts.busy(working.sessionRoot, false);
    await eventually(() => restarted.length === 2);
    expect(restarted[1]).toEqual({ root: working.sessionRoot, resuming: true, restart: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    abort.abort();
    await run;
    grantsNow.shape = null;
  }
  expect(restarted).toHaveLength(2);
});

it('restarts a session for its agent’s granted services once, even if it comes back without them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-regranted-once-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const session = await existing(root, config);
  await assignTo(root, config, 1, 'room', session.sessionId);
  await startedWith(session.sessionRoot, '[]');
  grantsNow.shape = '[{"service":"google-workspace"}]';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const hosts = sessionHosts();
  await hosts.start(session.sessionRoot);
  hosts.busy(session.sessionRoot, false);
  // The new host fails to read the grants itself, so it records the old ones.
  vi.mocked(ensureSharedProcess).mockImplementation(async () => ({ created: false }));

  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => vi.mocked(ensureSharedProcess).mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    abort.abort();
    await run;
    grantsNow.shape = null;
  }
  expect(ensureSharedProcess).toHaveBeenCalledTimes(1);
});

it('restarts a session’s host before handing it a reset, when its agent’s services changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-reset-regranted-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const granted = await existing(root, config);
  const unchanged = await existing(root, config);
  await startedWith(granted.sessionRoot, '[]');
  await startedWith(unchanged.sessionRoot, '[{"service":"google-workspace"}]');
  grantsNow.shape = '[{"service":"google-workspace"}]';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const hosts = sessionHosts();
  await hosts.start(granted.sessionRoot);
  await hosts.start(unchanged.sessionRoot);
  const order: string[] = [];
  vi.mocked(ensureSharedProcess).mockImplementation(async ({ root: sessionRoot, restart }) => {
    order.push(`restart ${sessionRoot} ${restart}`);
    await startedWith(sessionRoot, grantsNow.shape!);
    return { created: false };
  });
  const reset = (sessionId: string) => ({
    sessionId,
    commandId: `reset-${sessionId}`,
    body: { type: 'session.reset' },
  });

  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onSessionCommand!(reset(granted.sessionId));
    order.push(...hosts.to(granted.sessionRoot).map((request) => request.type));
    await streams[0]!.onSessionCommand!(reset(unchanged.sessionId));
  } finally {
    abort.abort();
    await run;
    grantsNow.shape = null;
  }
  expect(order.slice(0, 2)).toEqual([`restart ${granted.sessionRoot} true`, 'command']);
  expect(hosts.to(unchanged.sessionRoot)).toEqual([
    { type: 'command', command: reset(unchanged.sessionId), requesterName: null, direct: false },
  ]);
  expect(vi.mocked(ensureSharedProcess).mock.calls.map(([input]) => input.root)).toEqual([
    granted.sessionRoot,
  ]);
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
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(2, 'room'));
    await eventually(() => settled(root));
  } finally {
    abort.abort();
    await run;
  }
  const sessions = (await AgentHostAssignments.open(root)).sessions();
  expect(sessions).toHaveLength(2);
  expect(sessions.at(-1)!.session.sessionId).not.toBe(owner.sessionId);
  expect(hosts.to(owner.sessionRoot)).toEqual([]);
  // The room is the new session's now, and Switch was told.
  expect(published.at(-1)).toEqual({ [sessions.at(-1)!.session.sessionId]: 'room' });
  expect(hosts.to(join(root, sessions.at(-1)!.session.sessionId))).toMatchObject([
    { type: 'room', handoff: { messageId: 'message-2' } },
  ]);
});

it('forgets a session Console deleted, so its room starts a new one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-deleted-owner-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const owner = await existing(root, config);
  await assignTo(root, config, 1, 'room', owner.sessionId);
  const hosts = sessionHosts();
  const control = new WatcherControl();

  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    control,
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    await control.forget(owner.sessionId);
    await expect(stat(owner.sessionRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await streams[0]!.onEvent!(addressed(2, 'room'));
    await eventually(() => settled(root));
  } finally {
    abort.abort();
    await run;
  }
  const sessions = (await AgentHostAssignments.open(root)).sessions();
  const fresh = sessions.at(-1)!.session.sessionId;
  expect(fresh).not.toBe(owner.sessionId);
  expect(hosts.to(owner.sessionRoot)).toEqual([]);
  expect(published.at(-1)).toEqual({ [fresh]: 'room' });
  expect(hosts.to(join(root, fresh))).toMatchObject([
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
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
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
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
  const command = (sessionId: string) => ({ sessionId, commandId: `command-${sessionId}` });
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onSessionCommand!(command(own.sessionId));
    await streams[0]!.onSessionCommand!(command(other.sessionId));
    // This agent's, but with nothing running it: dropped and said, not started.
    await streams[0]!.onSessionCommand!(command(idle.sessionId));
    expect(hosts.to(own.sessionRoot)).toEqual([
      { type: 'command', command: command(own.sessionId), requesterName: null, direct: false },
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

it('starts the host of a session a failure took down, to hand it a retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-retry-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const faulted = await existing(root, config);
  const hosts = sessionHosts();
  vi.mocked(ensureSharedProcess).mockImplementation(async ({ root: sessionRoot }) => {
    await hosts.start(sessionRoot);
    return { created: false };
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
  const retry = {
    sessionId: faulted.sessionId,
    commandId: 'retry-1',
    body: { type: 'message.retry', messageId: 'm1' },
  };
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onSessionCommand!(retry);
    expect(vi.mocked(ensureSharedProcess).mock.calls.map(([input]) => input.root)).toEqual([
      faulted.sessionRoot,
    ]);
    expect(hosts.to(faulted.sessionRoot)).toEqual([
      { type: 'command', command: retry, requesterName: null, direct: false },
    ]);
  } finally {
    abort.abort();
    await run;
  }
});

it('stops stating a session placed in a room Switch says the agent is not in, and keeps the rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-gone-room-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const stale = await existing(root, config);
  const live = await existing(root, config);
  await writeFile(
    join(root, 'placements.json'),
    JSON.stringify({ placements: { [stale.sessionId]: 'room-deleted', [live.sessionId]: 'room' } })
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  placementsRefusal.refusedRooms = ['room-deleted'];
  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    sessionHosts().supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    streams[0]!.onConnected!();
    await eventually(() => published.length >= 1);
    placementsRefusal.refusedRooms = [];
    await eventually(
      async () =>
        JSON.parse(await readFile(join(root, 'placements.json'), 'utf8')).placements[
          stale.sessionId
        ] === undefined
    );
    const before = published.length;
    streams[0]!.onConnected!();
    await eventually(() => published.length === before + 1);
    expect(published.at(-1)).toEqual({ [live.sessionId]: 'room' });
  } finally {
    abort.abort();
    await run;
  }
});

it('drops a session’s placement once its room is deleted, and the live session keeps its room', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-room-deleted-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const deleted = await existing(root, config);
  const live = await existing(root, config);
  await writeFile(
    join(root, 'placements.json'),
    JSON.stringify({
      placements: { [deleted.sessionId]: 'room-deleted', [live.sessionId]: 'room' },
    })
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    sessionHosts().supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    // The controller's hub says the chat is gone, as Switch told it.
    await streams[0]!.onRoomGone!({ roomId: 'room-deleted', sessionId: deleted.sessionId });
    expect(JSON.parse(await readFile(join(root, 'placements.json'), 'utf8')).placements).toEqual({
      [live.sessionId]: 'room',
    });
    await eventually(() => published.length >= 1);
    expect(published.at(-1)).toEqual({ [live.sessionId]: 'room' });
  } finally {
    abort.abort();
    await run;
  }
});

it('keeps a placement when Switch could not be asked, rather than taking it for gone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-unanswered-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const placed = await existing(root, config);
  await writeFile(
    join(root, 'placements.json'),
    JSON.stringify({ placements: { [placed.sessionId]: 'room' } })
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  placementsRefusal.error = new Error('HTTP 503');
  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    sessionHosts().supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    streams[0]!.onConnected!();
    await eventually(() => published.length >= 1);
    expect(
      JSON.parse(await readFile(join(root, 'placements.json'), 'utf8')).placements[placed.sessionId]
    ).toBe('room');
  } finally {
    abort.abort();
    await run;
  }
});

describe('a reset for a resting session', () => {
  // Box A, 27 Oct: `!reset` to a parked session logged "Dropped command …:
  // session … is not running here" (its host had parked and exited), while
  // Switch had already told the room "Resetting my session".
  const resetIn = (roomId: string) => ({
    sessionId: null,
    roomId,
    roomTold: false,
    commandId: 'reset-1',
    body: { type: 'session.reset' },
    origin: { roomId, threadId: 'thread-1', messageId: 'message-1', actorId: '@ada:test' },
  });
  const parkedIn = async (prefix: string) => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    paths.root = root;
    const config = await spawning(root);
    const placed = await existing(root, config);
    await writeFile(
      join(root, 'placements.json'),
      JSON.stringify({ placements: { [placed.sessionId]: 'room-a' } })
    );
    return { root, config, placed };
  };
  /** Every room post made as the agent, by body and thread. */
  const posts = () => {
    const made: { body: string; thread_id?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (new URL(url).pathname.endsWith('/ops/post_message'))
        made.push(JSON.parse(String(init.body)));
      return Response.json({ result: { event_id: 'event' } });
    });
    return made;
  };

  it('starts the resting session and hands it the reset, saying it was resting', async () => {
    const { root, config, placed } = await parkedIn('shared-watch-reset-resting-');
    const hosts = sessionHosts();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const made = posts();
    const abort = new AbortController();
    const run = runAgentHost(
      root,
      config,
      abort.signal,
      hosts.supervision,
      new WatcherControl(),
      openSwitchStream
    );
    try {
      await eventually(() => streams.length === 1);
      await streams[0]!.onSessionCommand!(resetIn('room-a'));
    } finally {
      abort.abort();
      await run;
    }
    expect(vi.mocked(ensureSharedProcess).mock.calls.map(([input]) => input.root)).toEqual([
      placed.sessionRoot,
    ]);
    const { roomId: _room, roomTold: _told, ...command } = resetIn('room-a');
    expect(hosts.to(placed.sessionRoot)).toEqual([
      {
        type: 'command',
        command: { ...command, sessionId: placed.sessionId },
        requesterName: null,
        resting: true,
        roomTold: false,
      },
    ]);
    expect(warn.mock.calls.some(([line]) => String(line).includes('Dropped command'))).toBe(false);
    // The host says what happened once it has; the watcher says nothing itself.
    expect(made).toEqual([]);
  });

  it('tells the room it could not reset when the box is too full to start the session', async () => {
    const { root, config, placed } = await parkedIn('shared-watch-reset-full-');
    const hosts = sessionHosts();
    valve.admit = false;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const made = posts();
    const abort = new AbortController();
    const run = runAgentHost(
      root,
      config,
      abort.signal,
      hosts.supervision,
      new WatcherControl(),
      openSwitchStream
    );
    try {
      await eventually(() => streams.length === 1);
      await streams[0]!.onSessionCommand!(resetIn('room-a'));
    } finally {
      abort.abort();
      await run;
    }
    expect(ensureSharedProcess).not.toHaveBeenCalled();
    expect(hosts.to(placed.sessionRoot)).toEqual([]);
    expect(made).toEqual([
      {
        body: "I couldn't reset my session. Send the command again in a minute, or ask my owner to restart me from Switch Console.",
        thread_id: 'thread-1',
      },
    ]);
  });

  it('waits for a wake already under way and resets the session as awake, not resting', async () => {
    // A room message woke the session just before
    // its reset came. One start, not two, and no early park after it.
    const { root, config, placed } = await parkedIn('shared-watch-reset-waking-');
    const hosts = sessionHosts();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(ensureSharedProcess).mockImplementation(async ({ root: sessionRoot }) => {
      await gate;
      return hosts.start(sessionRoot);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const abort = new AbortController();
    const run = runAgentHost(
      root,
      config,
      abort.signal,
      hosts.supervision,
      new WatcherControl(),
      openSwitchStream
    );
    try {
      await eventually(() => streams.length === 1);
      // The message's start is held at the gate, as a slow wake would be.
      const routing = streams[0]!.onEvent!(addressed(2, 'room-a'));
      await eventually(() => vi.mocked(ensureSharedProcess).mock.calls.length === 1);
      const resetting = streams[0]!.onSessionCommand!(resetIn('room-a'));
      // Let the reset reach the start already under way before the wake ends.
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      await Promise.all([routing, resetting]);
      await eventually(() => hosts.to(placed.sessionRoot).some((r) => r.type === 'command'));
    } finally {
      abort.abort();
      await run;
    }
    expect(
      vi
        .mocked(ensureSharedProcess)
        .mock.calls.map(([input]) => [input.root, input.restart, input.resuming])
    ).toEqual([[placed.sessionRoot, false, false]]);
    const command = hosts.to(placed.sessionRoot).find((r) => r.type === 'command')!;
    expect(command).toMatchObject({ type: 'command', roomTold: false });
    expect(command).not.toHaveProperty('resting');
  });

  it('passes an awake session its reset as before, saying Switch left the room line to it', async () => {
    const { root, config, placed } = await parkedIn('shared-watch-reset-awake-');
    const hosts = sessionHosts();
    await hosts.start(placed.sessionRoot);
    vi.mocked(ensureSharedProcess).mockClear();
    const abort = new AbortController();
    const run = runAgentHost(
      root,
      config,
      abort.signal,
      hosts.supervision,
      new WatcherControl(),
      openSwitchStream
    );
    try {
      await eventually(() => streams.length === 1);
      await streams[0]!.onSessionCommand!(resetIn('room-a'));
    } finally {
      abort.abort();
      await run;
    }
    expect(ensureSharedProcess).not.toHaveBeenCalled();
    expect(hosts.to(placed.sessionRoot)).toMatchObject([
      { type: 'command', roomTold: false, requesterName: null },
    ]);
    expect(hosts.to(placed.sessionRoot)[0]).not.toHaveProperty('resting');
  });
});

it('hands a room control to the session working in its room, when Switch names only the room', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-room-control-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const placed = await existing(root, config);
  await writeFile(
    join(root, 'placements.json'),
    JSON.stringify({ placements: { [placed.sessionId]: 'room-a' } })
  );
  const hosts = sessionHosts();
  await hosts.start(placed.sessionRoot);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onSessionCommand!({
      sessionId: null,
      roomId: 'room-a',
      commandId: 'c1',
      direct: true,
    });
    await streams[0]!.onSessionCommand!({ sessionId: null, roomId: 'room-z', commandId: 'c2' });
    expect(hosts.to(placed.sessionRoot)).toEqual([
      {
        type: 'command',
        command: { sessionId: placed.sessionId, commandId: 'c1' },
        requesterName: null,
        direct: true,
      },
    ]);
    expect(
      warn.mock.calls.some((call) =>
        String(call[0]).includes(
          'Dropped command c2: no session of this agent works in room room-z'
        )
      )
    ).toBe(true);
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
    runAgentHost(
      root,
      config,
      new AbortController().signal,
      detached,
      new WatcherControl(),
      openSwitchStream
    )
  ).rejects.toThrow('parent of its sessions');
});

it('hands a message to its session over the IPC pipe and releases it once taken', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-ipc-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const hosts = sessionHosts();

  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream
  );
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
  const journal = await AgentHostAssignments.open(root);
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

  const run = runAgentHost(
    root,
    config,
    new AbortController().signal,
    hosts.supervision,
    control,
    openSwitchStream
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

  const run = runAgentHost(
    root,
    config,
    new AbortController().signal,
    hosts.supervision,
    control,
    openSwitchStream
  );
  await eventually(() => streams.length === 1);
  await writeFlags(root, { enabled: false, spawn: false });
  await run;
  expect(control.health()).toMatchObject({ state: 'disabled', detail: null, placements: {} });

  await writeFlags(root, { enabled: true, spawn: true });
  await rm(join(root, 'credentials.json'));
  await expect(
    runAgentHost(
      root,
      config,
      new AbortController().signal,
      hosts.supervision,
      control,
      openSwitchStream
    )
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
const quiet = { info: () => {}, warn: () => {} };

it('keeps a message whose session cannot start, tells the room once in plain words, and answers it once it can', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-failed-start-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const hosts = sessionHosts();
  hosts.fail = SIGN_IN;
  hosts.failKind = 'no_login';
  const calls = switchOperations({ owner: 'ada' });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const waits = new RoomWaitList({ retryMs: 20, startRetryMs: 600_000, log: quiet });

  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream,
    waits
  );
  try {
    await eventually(() => streams.length === 1);
    const first = addressed(1, 'room');
    (first.payload as { thread_id?: string }).thread_id = 'thread-root';
    const started = Date.now();
    await streams[0]!.onEvent!(first);
    await eventually(() => calls.some((call) => call.name === 'post_message'));
    // Told at once rather than after the wait for a host to come up.
    expect(Date.now() - started).toBeLessThan(5000);
    const sessionId = placementsOf(published).room!;
    expect(calls.map((call) => call.name)).toEqual(['get_agent_detail', 'post_message']);
    expect(calls[1]).toEqual({
      name: 'post_message',
      session: sessionId,
      body: { body: keptLine('no_login', 'ada'), thread_id: 'thread-root' },
    });
    // The raw failure stays in the log, never in the room.
    expect(JSON.stringify(calls)).not.toContain('claude auth login');
    expect(JSON.stringify(calls)).not.toContain('address me again');
    expect(error.mock.calls.some((call) => String(call[0]).includes(SIGN_IN))).toBe(true);
    // No retry loop: nothing starts the host again straight away.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(vi.mocked(ensureSharedProcess)).toHaveBeenCalledTimes(1);

    // A later message tries once more, and gets its own line; the first isn't told again.
    await streams[0]!.onEvent!(addressed(2, 'room'));
    await eventually(() => vi.mocked(ensureSharedProcess).mock.calls.length === 2);
    await eventually(() => calls.filter((call) => call.name === 'post_message').length === 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls.filter((call) => call.name === 'post_message')).toHaveLength(2);

    // Both messages are still owed, and wait (as starts, not for room).
    expect((await AgentHostAssignments.open(root)).pending().map((e) => e.messageId)).toEqual([
      'message-1',
      'message-2',
    ]);
    expect(waits.size).toBe(2);
    expect(waits.count(config.session.agentId).count).toBe(0);

    // Started from Console once it is fixed: the kept messages go to it, once each.
    hosts.fail = null;
    await hosts.start(join(root, sessionId));
    await eventually(() => settled(root));
    expect(
      hosts.to(join(root, sessionId)).map((request) => (request as { handoff: Handoff }).handoff)
    ).toMatchObject([{ messageId: 'message-1' }, { messageId: 'message-2' }]);
    expect(waits.size).toBe(0);
  } finally {
    abort.abort();
    await run;
  }
  expect(calls.filter((call) => call.name === 'post_message')).toHaveLength(2);
});

it('still tells the room a message is kept when its placements are not taken', async () => {
  // A statement that is refused (the controller hub reconnecting, say) used
  // to skip the notice after it, and the notice is sent once per message, so
  // the room heard nothing.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-failed-start-unplaced-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const hosts = sessionHosts();
  hosts.fail = SIGN_IN;
  hosts.failKind = 'no_login';
  const calls = switchOperations({ owner: 'ada' });
  placementsRefusal.error = new Error('the agent controller hub is not connected');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream,
    new RoomWaitList({ startRetryMs: 600_000, log: quiet })
  );
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
    await eventually(() => calls.some((call) => call.name === 'post_message'));
    expect(calls.find((call) => call.name === 'post_message')?.body).toMatchObject({
      body: keptLine('no_login', 'ada'),
    });
    expect(
      warn.mock.calls.some(([line]) =>
        String(line).startsWith('Could not state the session placements before telling room room')
      )
    ).toBe(true);
  } finally {
    abort.abort();
    await run;
  }
});

it("names no one when Switch doesn't say who the owner is, and survives a refused post", async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-failed-owner-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const hosts = sessionHosts();
  hosts.fail = 'The provider executable is missing.';
  hosts.failKind = 'setup';
  const calls = switchOperations({ owner: null });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream,
    new RoomWaitList({ startRetryMs: 600_000, log: quiet })
  );
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
    await eventually(() => calls.some((call) => call.name === 'post_message'));
    expect(calls.find((call) => call.name === 'post_message')!.body).toEqual({
      body: keptLine('setup', null),
    });
    expect(keptLine('setup', null)).toContain('My owner can see why');

    // A post Switch refuses is logged, not fatal.
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

it('tells the room once a session keeps not taking a message, instead of starting it forever', async () => {
  // A host that is up but never takes the message — it hung up its pipe and
  // stayed alive — used to be started again every few seconds, for ever,
  // with nobody told.
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-restart-cap-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const hosts = sessionHosts();
  hosts.drop = true;
  const calls = switchOperations({ owner: 'ada' });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runAgentHost(
    root,
    config,
    abort.signal,
    hosts.supervision,
    new WatcherControl(),
    openSwitchStream,
    // Kept, it is retried at the list's own pace, not in a loop; slow here.
    new RoomWaitList({ startRetryMs: 600_000, log: quiet })
  );
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
    // Bounded by real time, not by a count of fake seconds: each restart reads
    // the agent's template from disk, which advancing fake time does not wait for.
    const deadline = performance.now() + 20_000;
    while (!calls.some((call) => call.name === 'post_message') && performance.now() < deadline) {
      await vi.advanceTimersByTimeAsync(1000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const told = calls.filter((call) => call.name === 'post_message');
    expect(told).toHaveLength(1);
    // Nothing the owner can fix: the plain kept line, the cause in the log.
    expect((told[0]!.body as { body: string }).body).toBe(keptLine('unknown', 'ada'));
    expect(
      error.mock.calls.some((call) =>
        String(call[0]).includes(`after being started ${MAX_HOST_RESTARTS} times`)
      )
    ).toBe(true);

    // And it stops: nothing starts the host again on its own.
    const starts = vi.mocked(ensureSharedProcess).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(ensureSharedProcess).mock.calls.length).toBe(starts);
    // The message is still owed, for when the session can take it.
    expect((await AgentHostAssignments.open(root)).pending().map((e) => e.messageId)).toEqual([
      'message-1',
    ]);
  } finally {
    abort.abort();
    await run;
    vi.useRealTimers();
  }
});

describe('sessions a restart cut off mid-turn', () => {
  async function reconnecting(root: string) {
    paths.root = root;
    const config = await spawning(root);
    const cut = randomUUID();
    const finished = randomUUID();
    await assignTo(root, config, 1, 'room-cut', cut);
    await assignTo(root, config, 2, 'room-done', finished);
    journals.set(cut, ['completed', 'running']);
    journals.set(finished, ['completed', 'interrupted']);
    return { config, cut, finished };
  }

  it('starts again, on reconnecting, only the sessions whose journal holds an unfinished turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-cut-off-'));
    roots.push(root);
    const { config, cut } = await reconnecting(root);
    const abort = new AbortController();
    const run = runAgentHost(
      root,
      config,
      abort.signal,
      sessionHosts().supervision,
      new WatcherControl(),
      openSwitchStream
    );
    try {
      await eventually(() => streams.length === 1);
      streams[0]!.onConnected!();
      await eventually(() => vi.mocked(ensureSharedProcess).mock.calls.length === 1);
      // A second reconnect looks again only at what still isn't running.
      streams[0]!.onConnected!();
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      abort.abort();
      await run;
    }
    expect(
      vi.mocked(ensureSharedProcess).mock.calls.map(([input]) => input.config.session.sessionId)
    ).toEqual([cut]);
    expect(valve.asked).toBe(1);
  });

  it('also starts a session whose turn already reads interrupted but which still owes its room the line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-cut-off-owed-'));
    roots.push(root);
    const { config, cut, finished } = await reconnecting(root);
    // A clean stop: the provider exited first, so the journal says interrupted, and the host owes the line.
    journals.set(cut, ['completed', 'interrupted']);
    await mkdir(join(root, cut), { recursive: true });
    await writeFile(
      join(root, cut, 'inbox.jsonl'),
      JSON.stringify({ type: 'restart-reply', commandId: 'turn-1', state: 'pending' }) + '\n'
    );
    // Already told: owes nothing.
    await mkdir(join(root, finished), { recursive: true });
    await writeFile(
      join(root, finished, 'inbox.jsonl'),
      JSON.stringify({ type: 'restart-reply', commandId: 'turn-1', state: 'pending' }) +
        '\n' +
        JSON.stringify({ type: 'restart-reply', commandId: 'turn-1', state: 'sent' }) +
        '\n'
    );
    const abort = new AbortController();
    const run = runAgentHost(
      root,
      config,
      abort.signal,
      sessionHosts().supervision,
      new WatcherControl(),
      openSwitchStream
    );
    try {
      await eventually(() => streams.length === 1);
      streams[0]!.onConnected!();
      await eventually(() => vi.mocked(ensureSharedProcess).mock.calls.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      abort.abort();
      await run;
    }
    expect(
      vi.mocked(ensureSharedProcess).mock.calls.map(([input]) => input.config.session.sessionId)
    ).toEqual([cut]);
  });

  it('asks a running session that still owes its line to try again when Switch comes back', async () => {
    // Switch unreachable for longer than the host's 2-minute round
    // just after a restart. The session is up, its line still pending; only
    // the reconnect says Switch can take it now.
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-owed-live-'));
    roots.push(root);
    const { config, cut, finished } = await reconnecting(root);
    journals.set(cut, ['completed', 'interrupted']);
    journals.set(finished, ['completed', 'completed']);
    await mkdir(join(root, cut), { recursive: true });
    await writeFile(
      join(root, cut, 'inbox.jsonl'),
      JSON.stringify({ type: 'restart-reply', commandId: 'turn-1', state: 'pending' }) + '\n'
    );
    const hosts = sessionHosts();
    await hosts.start(join(root, cut));
    await hosts.start(join(root, finished));
    const abort = new AbortController();
    const run = runAgentHost(
      root,
      config,
      abort.signal,
      hosts.supervision,
      new WatcherControl(),
      openSwitchStream
    );
    const retries = () =>
      hosts.requests.filter((r) => r.request.type === 'restart-replies').map((r) => r.root);
    try {
      await eventually(() => streams.length === 1);
      // The first connection: the startup pass, which leaves running sessions alone.
      streams[0]!.onConnected!();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(retries()).toEqual([]);
      // Back after an outage: the running session that owes a line is asked again.
      streams[0]!.onConnected!();
      await eventually(() => retries().length === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      abort.abort();
      await run;
    }
    expect(retries()).toEqual([join(root, cut)]);
    expect(vi.mocked(ensureSharedProcess)).not.toHaveBeenCalled();
  });

  it('does not start a cut-off session again while the box is out of memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-cut-off-full-'));
    roots.push(root);
    const { config, cut } = await reconnecting(root);
    valve.admit = false;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const abort = new AbortController();
    const run = runAgentHost(
      root,
      config,
      abort.signal,
      sessionHosts().supervision,
      new WatcherControl(),
      openSwitchStream
    );
    try {
      await eventually(() => streams.length === 1);
      streams[0]!.onConnected!();
      await eventually(() => valve.asked === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      abort.abort();
      await run;
    }
    expect(vi.mocked(ensureSharedProcess)).not.toHaveBeenCalled();
    expect(
      warning.mock.calls.some(([line]) =>
        String(line).includes(`Session ${cut} has a turn a restart cut off`)
      )
    ).toBe(true);
  });
});

describe('the memory ceiling on a first start', () => {
  it("doesn't start a parked session when the box is full: it waits for room", async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-box-full-'));
    roots.push(root);
    paths.root = root;
    const config = await spawning(root);
    const hosts = sessionHosts();
    valve.admit = false;
    switchOperations({ owner: 'ada' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const control = new WatcherControl();
    const reports = vi.spyOn(control, 'report');
    const abort = new AbortController();
    const run = runAgentHost(
      root,
      config,
      abort.signal,
      hosts.supervision,
      control,
      openSwitchStream,
      new RoomWaitList({ retryMs: 60_000, log: { info: () => {}, warn: () => {} } })
    );
    try {
      await eventually(() => streams.length === 1);
      await streams[0]!.onEvent!(addressed(1, 'room'));
      await eventually(async () =>
        (await readFile(join(root, 'assignments.jsonl'), 'utf8')).includes('"waiting"')
      );
      // Turned away for now, it no longer shows "Back in a moment" while the
      // box is still running: the latest report has it resting, not waking.
      const states = () =>
        reports.mock.calls.map(([change]) => change.sessions).filter((s) => s !== undefined);
      expect(states().some((s) => Object.values(s).includes('waking'))).toBe(true);
      expect(Object.values(states().at(-1)!)).not.toContain('waking');
    } finally {
      abort.abort();
      await run;
    }
    expect(vi.mocked(ensureSharedProcess)).not.toHaveBeenCalled();
    expect(valve.asked).toBe(1);
    expect(valve.settled).toBe(0);
    // Not let go: still held in the journal, for the next start of the host.
    expect((await AgentHostAssignments.open(root)).pending()).toHaveLength(1);
  });

  it('asks the ceiling once per start it makes, and settles it once the session is up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-box-room-'));
    roots.push(root);
    paths.root = root;
    const config = await spawning(root);
    const hosts = sessionHosts();
    const abort = new AbortController();
    const run = runAgentHost(
      root,
      config,
      abort.signal,
      hosts.supervision,
      new WatcherControl(),
      openSwitchStream
    );
    try {
      await eventually(() => streams.length === 1);
      await streams[0]!.onEvent!(addressed(1, 'room'));
      await eventually(() => hosts.requests.length === 1);
    } finally {
      abort.abort();
      await run;
    }
    expect(vi.mocked(ensureSharedProcess)).toHaveBeenCalledTimes(1);
    expect(valve.asked).toBe(1);
    expect(valve.settled).toBe(1);
  });
});

describe('wait for room', () => {
  const posts = (calls: ReturnType<typeof switchOperations>) =>
    calls.filter((call) => call.name === 'post_message').map((call) => call.body.body);
  const journalText = (root: string) => readFile(join(root, 'assignments.jsonl'), 'utf8');

  async function waitingHost(
    root: string,
    waits: RoomWaitList,
    options: {
      control?: WatcherControl;
      hosts?: ReturnType<typeof sessionHosts>;
      openStream?: OpenAgentStream;
    } = {}
  ) {
    const config = await spawning(root);
    const hosts = options.hosts ?? sessionHosts();
    const control = options.control ?? new WatcherControl();
    const abort = new AbortController();
    const opened = streams.length;
    const run = runAgentHost(
      root,
      config,
      abort.signal,
      hosts.supervision,
      control,
      options.openStream ?? openSwitchStream,
      waits
    );
    await eventually(() => streams.length === opened + 1);
    return {
      hosts,
      control,
      stream: streams[opened]!,
      stop: async () => {
        abort.abort();
        await run;
      },
    };
  }

  function setUp(prefix: string) {
    return (async () => {
      const root = await mkdtemp(join(tmpdir(), prefix));
      roots.push(root);
      paths.root = root;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});
      return root;
    })();
  }

  describe('on the box valve', () => {
    /** The controller's valve with another agent holding every slot until `free()`. */
    function boxFull(over: Partial<ConstructorParameters<typeof BoxValve>[0]> = {}) {
      const box = new BoxValve({
        limit: 6 * 1024 ** 3,
        readUsage: async () => 0,
        cap: 1,
        settleMs: 0,
        log: quiet,
        ...over,
      });
      let otherAwake = 1;
      box.connect({
        agentId: 'another-agent',
        awake: () => otherAwake,
        idle: () => [],
        park: async () => false,
        start: () => {},
        letGo: () => {},
      });
      const openStream: OpenAgentStream = Object.assign(
        (deps: SwitchEventStreamDeps) => openSwitchStream(deps),
        { boxValve: box }
      );
      return {
        box,
        openStream,
        free: () => {
          otherAwake = 0;
        },
      };
    }

    it('waits with one line, and starts when the box valve gives it room', async () => {
      const root = await setUp('shared-watch-box-valve-');
      const { box, openStream, free } = boxFull();
      const calls = switchOperations({ owner: 'ada' });
      // The host's own retries are slow: only the box valve's start can start it.
      const waits = new RoomWaitList({ retryMs: 60_000, log: quiet });
      const host = await waitingHost(root, waits, { openStream });
      try {
        await host.stream.onEvent!(addressed(1, 'room'));
        await eventually(() => posts(calls).length === 1);
        expect(posts(calls)).toEqual([WAITING_FOR_ROOM_MESSAGE]);
        expect(box.status()).toMatchObject({ waiting: 1, waitingForRoom: 1 });
        // The F1 mock is never asked: the box valve decides.
        expect(valve.asked).toBe(0);
        free();
        await box.tick();
        await eventually(() => host.hosts.requests.length === 1);
        await eventually(() => box.status().waiting === 0);
        await eventually(() => box.starting === 0);
      } finally {
        await host.stop();
      }
      expect(posts(calls)).toEqual([WAITING_FOR_ROOM_MESSAGE]);
      expect(vi.mocked(ensureSharedProcess)).toHaveBeenCalledTimes(1);
    });

    it('starts on the box valve’s start when a younger message on another agent also waits on a busy box', async () => {
      const root = await setUp('shared-watch-box-valve-two-');
      const { box, openStream, free } = boxFull();
      const calls = switchOperations({ owner: 'ada' });
      // The host's own retries are slow, and would be refused `busy` anyway while another agent's message waits:
      // only the box valve's reserved room can let it in.
      const waits = new RoomWaitList({ retryMs: 60_000, log: quiet });
      const host = await waitingHost(root, waits, { openStream });
      try {
        await host.stream.onEvent!(addressed(1, 'room'));
        await eventually(() => box.status().waitingForRoom === 1);
        // Another agent's message waits too, younger than this host's.
        const other = box.connect({
          agentId: 'agent-waiting-too',
          awake: () => 0,
          idle: () => [],
          park: async () => false,
          start: () => {},
          letGo: () => {},
        });
        expect(
          other.wait({
            roomId: 'r2',
            messageId: 'm2',
            sessionId: 's2',
            sinceMs: Date.now(),
            kind: 'room',
          })
        ).toBe('waiting');
        free();
        await box.tick();
        // Oldest first: this host's message gets the room and its session starts.
        await eventually(() => host.hosts.requests.length === 1);
        await eventually(() => box.status().waitingForRoom === 1);
        expect(posts(calls)).toEqual([WAITING_FOR_ROOM_MESSAGE]);
      } finally {
        await host.stop();
      }
    });

    it("lets a message go with only the stopped line when the agent's share of the box list is full", async () => {
      const root = await setUp('shared-watch-box-valve-full-');
      const { openStream } = boxFull({ maxPerAgent: 1 });
      const calls = switchOperations({ owner: 'ada' });
      const waits = new RoomWaitList({ retryMs: 60_000, log: quiet });
      const host = await waitingHost(root, waits, { openStream });
      try {
        await host.stream.onEvent!(addressed(1, 'room-a'));
        await eventually(() => posts(calls).length === 1);
        await host.stream.onEvent!(addressed(2, 'room-b'));
        await eventually(() => posts(calls).length === 2);
        expect(posts(calls)).toEqual([WAITING_FOR_ROOM_MESSAGE, STOPPED_WAITING_MESSAGE]);
        await eventually(async () =>
          (await journalText(root)).includes('no room in time (list full)')
        );
        expect(waits.size).toBe(1);
      } finally {
        await host.stop();
      }
    });

    it('lets go with the stopped line when the box valve says its time is up', async () => {
      const root = await setUp('shared-watch-box-valve-timeout-');
      const { box, openStream } = boxFull({ maxWaitMs: 100 });
      const calls = switchOperations({ owner: 'ada' });
      // The host's own limit is longer: the box valve's letGo decides.
      const waits = new RoomWaitList({ retryMs: 60_000, log: quiet });
      const host = await waitingHost(root, waits, { openStream });
      try {
        await host.stream.onEvent!(addressed(1, 'room'));
        await eventually(() => posts(calls).length === 1);
        await new Promise((resolve) => setTimeout(resolve, 120));
        await box.tick();
        await eventually(() => posts(calls).length === 2);
        expect(posts(calls)).toEqual([WAITING_FOR_ROOM_MESSAGE, STOPPED_WAITING_MESSAGE]);
        await eventually(() => waits.size === 0);
        await eventually(async () =>
          (await journalText(root)).includes('no room in time (timed out)')
        );
      } finally {
        await host.stop();
      }
    });

    it('leaves the box valve when it stops: its waiters go without a line', async () => {
      const root = await setUp('shared-watch-box-valve-stop-');
      const { box, openStream } = boxFull();
      const calls = switchOperations({ owner: 'ada' });
      const waits = new RoomWaitList({ retryMs: 60_000, log: quiet });
      const host = await waitingHost(root, waits, { openStream });
      await host.stream.onEvent!(addressed(1, 'room'));
      await eventually(() => box.status().waiting === 1);
      await host.stop();
      expect(box.status().waiting).toBe(0);
      expect(posts(calls)).toEqual([WAITING_FOR_ROOM_MESSAGE]);
    });
  });

  it('holds a message the box has no room for, says so once, and starts it by itself once there is room', async () => {
    const root = await setUp('shared-watch-wait-');
    valve.admit = false;
    const calls = switchOperations({ owner: 'ada' });
    const waits = new RoomWaitList({ retryMs: 20, log: quiet });
    const host = await waitingHost(root, waits);
    try {
      await host.stream.onEvent!(threaded(addressed(1, 'room'), 'thread-root'));
      await eventually(() => posts(calls).length === 1);
      expect(posts(calls)).toEqual([WAITING_FOR_ROOM_MESSAGE]);
      expect(calls.find((call) => call.name === 'post_message')!.body.thread_id).toBe(
        'thread-root'
      );
      const sessionId = placementsOf(published).room!;
      // Console's amber card, and busy: nothing waiting for idle takes it as idle.
      await eventually(() => host.control.health().waitingForRoom?.count === 1);
      expect(host.control.health().busy).toContain(sessionId);
      // A second message to the same room waits behind the first, without
      // asking the gate again for itself.
      const askedBefore = valve.asked;
      await host.stream.onEvent!(addressed(2, 'room'));
      await eventually(() => waits.size === 2);
      expect(posts(calls)).toEqual([WAITING_FOR_ROOM_MESSAGE, WAITING_FOR_ROOM_MESSAGE]);
      // Still no room: it keeps trying, every retry through the same gate.
      await eventually(() => valve.asked >= askedBefore + 2);
      expect(vi.mocked(ensureSharedProcess)).not.toHaveBeenCalled();
      // Room frees up: one start, both messages handed over in order, no extra line.
      valve.admit = true;
      await eventually(() => host.hosts.requests.length === 2);
      expect(
        host.hosts.requests.map(
          (entry) => (entry.request as { handoff?: Handoff }).handoff?.messageId
        )
      ).toEqual(['message-1', 'message-2']);
      await eventually(() => settled(root));
      await eventually(() => host.control.health().waitingForRoom?.count === 0);
      // Up and idle, it is no longer busy for waiting.
      host.hosts.busy(join(root, sessionId), false);
      await eventually(() => !(host.control.health().busy ?? []).includes(sessionId));
    } finally {
      await host.stop();
    }
    expect(vi.mocked(ensureSharedProcess)).toHaveBeenCalledTimes(1);
    expect(posts(calls)).toHaveLength(2);
    expect(waits.size).toBe(0);
  });

  it('lets a message go with the agreed line once it has waited its limit', async () => {
    const root = await setUp('shared-watch-wait-limit-');
    valve.admit = false;
    const calls = switchOperations({ owner: 'ada' });
    const waits = new RoomWaitList({ retryMs: 20, maxWaitMs: 150, log: quiet });
    const host = await waitingHost(root, waits);
    try {
      await host.stream.onEvent!(addressed(1, 'room'));
      await eventually(() => posts(calls).length === 2);
      expect(posts(calls)).toEqual([WAITING_FOR_ROOM_MESSAGE, STOPPED_WAITING_MESSAGE]);
      await eventually(() => settled(root));
      expect(await journalText(root)).toContain('no room in time (timed out)');
      await eventually(() => host.control.health().waitingForRoom?.count === 0);
    } finally {
      await host.stop();
    }
    expect(vi.mocked(ensureSharedProcess)).not.toHaveBeenCalled();
  });

  it('lets a message go straight away when the box already has its limit waiting', async () => {
    const root = await setUp('shared-watch-wait-full-');
    valve.admit = false;
    const calls = switchOperations({ owner: 'ada' });
    const waits = new RoomWaitList({ retryMs: 60_000, max: 1, log: quiet });
    const host = await waitingHost(root, waits);
    try {
      await host.stream.onEvent!(addressed(1, 'room-a'));
      await eventually(() => waits.size === 1);
      await host.stream.onEvent!(addressed(2, 'room-b'));
      await eventually(() => posts(calls).length === 2);
      expect(posts(calls)).toEqual([WAITING_FOR_ROOM_MESSAGE, STOPPED_WAITING_MESSAGE]);
      expect(await journalText(root)).toContain('no room in time (list full)');
      expect(waits.size).toBe(1);
    } finally {
      await host.stop();
    }
  });

  it('puts a new message behind those already waiting, so freed room goes to the oldest first', async () => {
    // A newcomer needing a new session went straight to the gate
    // and took room that freed up between retries, ahead of older messages.
    const root = await setUp('shared-watch-wait-order-');
    valve.admit = false;
    const calls = switchOperations({ owner: 'ada' });
    // No timer rounds in this test: only the newcomer's own round runs.
    const waits = new RoomWaitList({ retryMs: 600_000, log: quiet });
    const host = await waitingHost(root, waits);
    try {
      await host.stream.onEvent!(addressed(1, 'room-old'));
      await eventually(() => waits.size === 1);
      const asked = valve.asked;
      valve.admit = true;
      await host.stream.onEvent!(addressed(2, 'room-new'));
      await eventually(() => host.hosts.requests.length === 2);
      // Joined the list without asking the gate for itself first.
      expect(posts(calls)).toEqual([WAITING_FOR_ROOM_MESSAGE, WAITING_FOR_ROOM_MESSAGE]);
      expect(valve.asked).toBe(asked + 2);
    } finally {
      await host.stop();
    }
    const started = vi
      .mocked(ensureSharedProcess)
      .mock.calls.map(([input]) => input.config.session.sessionId);
    const map = placementsOf(published);
    expect(started).toEqual([map['room-old'], map['room-new']]);
  });

  it('keeps waiting messages through a host restart: same start time, no second line', async () => {
    const root = await setUp('shared-watch-wait-restart-');
    valve.admit = false;
    const calls = switchOperations({ owner: 'ada' });
    const waits = new RoomWaitList({ retryMs: 20, log: quiet });
    const first = await waitingHost(root, waits);
    let oldest: string | null = null;
    try {
      await first.stream.onEvent!(addressed(1, 'room'));
      await eventually(() => waits.size === 1);
      // Told, and recorded as told, before the restart.
      await eventually(async () => (await journalText(root)).includes('"told"'));
      oldest = waits.count(config(root)).oldestSince;
    } finally {
      // Stopped as the memory guard stops it, or a restart: off the list, no line.
      await first.stop();
    }
    expect(waits.size).toBe(0);
    expect((await AgentHostAssignments.open(root)).pending()).toHaveLength(1);
    expect(await journalText(root)).not.toContain('"released"');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await waitingHost(root, waits);
    try {
      await eventually(() => waits.size === 1);
      expect(waits.count(config(root)).oldestSince).toBe(oldest);
      valve.admit = true;
      await eventually(() => second.hosts.requests.length === 1);
      await eventually(() => settled(root));
    } finally {
      await second.stop();
    }
    expect(posts(calls)).toEqual([WAITING_FOR_ROOM_MESSAGE]);
  });

  it('lets go, after a restart, a message that waited past its limit meanwhile', async () => {
    const root = await setUp('shared-watch-wait-expired-');
    valve.admit = false;
    const calls = switchOperations({ owner: 'ada' });
    const waits = new RoomWaitList({ retryMs: 20, maxWaitMs: 200, log: quiet });
    const first = await waitingHost(root, waits);
    try {
      await first.stream.onEvent!(addressed(1, 'room'));
      await eventually(() => waits.size === 1);
    } finally {
      await first.stop();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await waitingHost(root, waits);
    try {
      await eventually(() => posts(calls).length === 2);
      await eventually(() => settled(root));
    } finally {
      await second.stop();
    }
    expect(posts(calls)).toEqual([WAITING_FOR_ROOM_MESSAGE, STOPPED_WAITING_MESSAGE]);
    expect(vi.mocked(ensureSharedProcess)).not.toHaveBeenCalled();
  });

  it('lets go of what waits for a session that is reset meanwhile, with the reset line', async () => {
    const root = await setUp('shared-watch-wait-reset-');
    valve.admit = false;
    const calls = switchOperations({ owner: 'ada' });
    const waits = new RoomWaitList({ retryMs: 60_000, log: quiet });
    const host = await waitingHost(root, waits);
    try {
      await host.stream.onEvent!(addressed(1, 'room'));
      await eventually(() => waits.size === 1);
      await host.stream.onSessionCommand!({
        sessionId: null,
        roomId: 'room',
        commandId: 'reset-1',
        body: { type: 'session.reset' },
      });
      await eventually(() => posts(calls).length === 2);
      expect(posts(calls)).toEqual([WAITING_FOR_ROOM_MESSAGE, RESET_WHILE_WAITING_MESSAGE]);
      await eventually(() => settled(root));
      expect(await journalText(root)).toContain('reset while waiting for room');
      expect(waits.size).toBe(0);
    } finally {
      await host.stop();
    }
    expect(vi.mocked(ensureSharedProcess)).not.toHaveBeenCalled();
  });

  it("removes a delivered message's text from the journal as soon as it is released", async () => {
    const root = await setUp('shared-watch-wait-leak-');
    const waits = new RoomWaitList({ retryMs: 20, log: quiet });
    switchOperations({ owner: 'ada' });
    const secret = 'leak-scan-marker-7f3a';
    const event = addressed(1, 'room');
    (event.payload as { body: string }).body = secret;
    valve.admit = false;
    const first = await waitingHost(root, waits);
    try {
      await first.stream.onEvent!(event);
      await eventually(() => waits.size === 1);
      // Held: the text is in the journal, as nothing else keeps it.
      expect(await journalText(root)).toContain(secret);
      valve.admit = true;
      await eventually(() => first.hosts.requests.length === 1);
      await eventually(() => settled(root));
      // Gone from the file within seconds of its
      // release (one quiet second, the burst debounce), not at the next
      // compaction or host start.
      const released = Date.now();
      while ((await journalText(root)).includes(secret) && Date.now() - released < 3000)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await journalText(root)).not.toContain(secret);
    } finally {
      await first.stop();
    }
    const second = await waitingHost(root, waits);
    try {
      await eventually(async () => !(await journalText(root)).includes(secret));
    } finally {
      await second.stop();
    }
    const reopened = await AgentHostAssignments.open(root);
    expect(reopened.cursor).toBe(1);
    expect(reopened.pending()).toEqual([]);
    expect(reopened.sessions()).toHaveLength(1);
    expect(await journalText(root)).not.toContain('"waiting"');
  });

  describe('a session that cannot start', () => {
    it('retries a start with nothing to fix on its own clock: one line, one answer', async () => {
      const root = await setUp('shared-watch-b78-login-');
      const hosts = sessionHosts();
      // No kind recorded: nothing the owner can fix, so the 30 s clock applies.
      hosts.fail = 'The session host exited with code 1.';
      const calls = switchOperations({ owner: 'ada' });
      const waits = new RoomWaitList({ retryMs: 20, startRetryMs: 100, log: quiet });
      const host = await waitingHost(root, waits, { hosts });
      try {
        await host.stream.onEvent!(addressed(1, 'room'));
        await eventually(() => posts(calls).length === 1);
        expect(posts(calls)).toEqual([keptLine('unknown', 'ada')]);
        // Whatever stopped it clears: the next retry starts it and it is answered.
        hosts.fail = null;
        await eventually(() => hosts.requests.length === 1);
        await eventually(() => settled(root));
        expect(waits.size).toBe(0);
      } finally {
        await host.stop();
      }
      expect(posts(calls)).toEqual([keptLine('unknown', 'ada')]);
      expect(hosts.requests).toHaveLength(1);
    });

    it("replays the 27 Oct login case: no login, then the login lands, and it's answered once with no extra line", async () => {
      // 27 Oct (user-b-lead): sent 14:46:50, can't-start line 14:47:21,
      // login at 15:05:01, answered 15:05:24, after being told to resend.
      // Scaled: the login lands well inside the limit here; past it, see below.
      const root = await setUp('shared-watch-b78-bl1-');
      const hosts = sessionHosts();
      hosts.fail = SIGN_IN;
      hosts.failKind = 'no_login';
      const calls = switchOperations({ owner: 'ada' });
      // Fast clocks, so a 30 s retry would show: a no-login wait must not use it.
      const waits = new RoomWaitList({ retryMs: 20, startRetryMs: 50, log: quiet });
      const host = await waitingHost(root, waits, { hosts });
      try {
        await host.stream.onEvent!(addressed(1, 'room'));
        await eventually(() => posts(calls).length === 1);
        expect(posts(calls)).toEqual([keptLine('no_login', 'ada')]);
        await new Promise((resolve) => setTimeout(resolve, 400));
        // No host started again on a fast clock while only a person can fix it.
        expect(vi.mocked(ensureSharedProcess)).toHaveBeenCalledTimes(1);
        // The login lands: the controller replaces the agent's definition.
        hosts.fail = null;
        const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
        await writeFile(join(root, 'config.json.tmp'), JSON.stringify(config));
        await rename(join(root, 'config.json.tmp'), join(root, 'config.json'));
        await eventually(() => hosts.requests.length === 1);
        await eventually(() => settled(root));
      } finally {
        await host.stop();
      }
      expect(posts(calls)).toEqual([keptLine('no_login', 'ada')]);
      expect(JSON.stringify(calls)).not.toContain('address me again');
      expect(hosts.requests).toHaveLength(1);
    });

    it('lets a kept message go at its limit with one line, and never answers it after', async () => {
      const root = await setUp('shared-watch-b78-limit-');
      const hosts = sessionHosts();
      hosts.fail = SIGN_IN;
      hosts.failKind = 'no_login';
      const calls = switchOperations({ owner: 'ada' });
      const waits = new RoomWaitList({
        retryMs: 20,
        startRetryMs: 600_000,
        maxWaitMs: 200,
        log: quiet,
      });
      const host = await waitingHost(root, waits, { hosts });
      try {
        await host.stream.onEvent!(addressed(1, 'room'));
        await eventually(() => posts(calls).length === 2);
        expect(posts(calls)).toEqual([keptLine('no_login', 'ada'), START_LET_GO_MESSAGE]);
        await eventually(() => settled(root));
        expect(await journalText(root)).toContain('no start in time (timed out)');
        // The login lands afterwards, and the session is started from Console:
        // the let-go message is not answered.
        hosts.fail = null;
        const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
        await writeFile(join(root, 'config.json.tmp'), JSON.stringify(config));
        await rename(join(root, 'config.json.tmp'), join(root, 'config.json'));
        const sessionId = placementsOf(published).room!;
        await hosts.start(join(root, sessionId));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(hosts.to(join(root, sessionId))).toEqual([]);
        // A resend after the let-go line is answered, once.
        await host.stream.onEvent!(addressed(2, 'room'));
        await eventually(() => hosts.requests.length === 1);
        expect((hosts.requests[0]!.request as { handoff: Handoff }).handoff.messageId).toBe(
          'message-2'
        );
      } finally {
        await host.stop();
      }
      expect(posts(calls)).toEqual([keptLine('no_login', 'ada'), START_LET_GO_MESSAGE]);
    });

    it('lets a kept message go with the session-closed line when Console deletes its session', async () => {
      const root = await setUp('shared-watch-b78-forget-');
      const hosts = sessionHosts();
      hosts.fail = SIGN_IN;
      hosts.failKind = 'no_login';
      const calls = switchOperations({ owner: 'ada' });
      const waits = new RoomWaitList({ retryMs: 20, startRetryMs: 600_000, log: quiet });
      const host = await waitingHost(root, waits, { hosts });
      try {
        await host.stream.onEvent!(addressed(1, 'room'));
        await eventually(() => waits.size === 1);
        // The kept line is posted beside the keep, not awaited by it: let it go out first.
        await eventually(() => posts(calls).length === 1);
        const sessionId = placementsOf(published).room!;
        await host.control.forget(sessionId);
        await eventually(() => posts(calls).length === 2);
        expect(posts(calls)).toEqual([keptLine('no_login', 'ada'), SESSION_CLOSED_MESSAGE]);
        expect(waits.size).toBe(0);
        expect(await settled(root)).toBe(true);
        expect(await journalText(root)).toContain('session deleted');
      } finally {
        await host.stop();
      }
      // Nothing comes back on a restart, and nothing is answered.
      hosts.fail = null;
      const again = await waitingHost(root, waits, { hosts });
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
      } finally {
        await again.stop();
      }
      expect(hosts.requests).toEqual([]);
      expect(posts(calls)).toHaveLength(2);
    });

    it('tells the room again after a restart when the kept line never went through', async () => {
      // Found in review: the line was recorded as said before it was
      // posted, so a post lost while Switch was away was never retried.
      const root = await setUp('shared-watch-b78-untold-');
      const hosts = sessionHosts();
      hosts.fail = SIGN_IN;
      hosts.failKind = 'no_login';
      const calls = switchOperations({ owner: 'ada' });
      const waits = new RoomWaitList({ retryMs: 20, startRetryMs: 600_000, log: quiet });
      // Switch refuses every post at first.
      const working = globalThis.fetch;
      vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
      const first = await waitingHost(root, waits, { hosts });
      try {
        await first.stream.onEvent!(addressed(1, 'room'));
        await eventually(() => waits.size === 1);
        await eventually(async () => (await journalText(root)).includes('"waiting"'));
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        await first.stop();
      }
      expect(await journalText(root)).not.toContain('"told"');
      expect(posts(calls)).toEqual([]);
      // Switch is back; the host restarts and keeps the message again.
      vi.stubGlobal('fetch', working);
      const second = await waitingHost(root, waits, { hosts });
      try {
        await eventually(() => posts(calls).length === 1);
        await eventually(async () => (await journalText(root)).includes('"told"'));
        // The login lands: answered once, with no second line.
        hosts.fail = null;
        const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
        await writeFile(join(root, 'config.json.tmp'), JSON.stringify(config));
        await rename(join(root, 'config.json.tmp'), join(root, 'config.json'));
        await eventually(() => hosts.requests.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        await second.stop();
      }
      expect(posts(calls)).toEqual([keptLine('no_login', 'ada')]);
      expect(hosts.requests).toHaveLength(1);
    });

    it('keeps a kept message through a host restart without telling the room again', async () => {
      const root = await setUp('shared-watch-b78-restart-');
      const hosts = sessionHosts();
      hosts.fail = SIGN_IN;
      hosts.failKind = 'no_login';
      const calls = switchOperations({ owner: 'ada' });
      const waits = new RoomWaitList({ retryMs: 20, startRetryMs: 600_000, log: quiet });
      const first = await waitingHost(root, waits, { hosts });
      try {
        await first.stream.onEvent!(addressed(1, 'room'));
        await eventually(() => waits.size === 1);
        await eventually(async () => (await journalText(root)).includes('"told"'));
      } finally {
        await first.stop();
      }
      expect(waits.size).toBe(0);
      const second = await waitingHost(root, waits, { hosts });
      try {
        // Started again on restart, it fails again: kept again, not told again.
        await eventually(() => waits.size === 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        await second.stop();
      }
      expect(posts(calls)).toEqual([keptLine('no_login', 'ada')]);
      expect((await AgentHostAssignments.open(root)).pending()).toHaveLength(1);
    });
  });

  /** The agent id the watcher reports waiting messages under. */
  function config(root: string): string {
    return (
      JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as {
        session: { agentId: string };
      }
    ).session.agentId;
  }
});

describe('compacting the assignment journal', () => {
  it('reads the same before and after: cursor, held messages, placements and sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-compact-'));
    roots.push(root);
    const config = watchable(root);
    // Built whole first: a release compacts at once,
    // which this test holds back to compare everything before and after.
    const held = vi
      .spyOn(
        AgentHostAssignments.prototype as unknown as { compactNow: () => Promise<void> },
        'compactNow'
      )
      .mockResolvedValue(undefined);
    const assignments = await AgentHostAssignments.open(root);
    // An earlier numbering: a room assigned, a message held and delivered, one
    // held and still waiting (text kept), then the server restarts.
    const a = await assignments.assign(config, { sequence: 1, roomId: 'a', messageId: 'a1' });
    await assignments.handled(1);
    await assignments.park(
      { sequence: 2, roomId: 'a', messageId: 'a2', event: { t: 'text-done' } },
      true
    );
    await assignments.released({ roomId: 'a', messageId: 'a2' }, null);
    await assignments.park(
      { sequence: 3, roomId: 'h', messageId: 'h1', event: { t: 'text-held' } },
      true
    );
    await assignments.waiting({ roomId: 'h', messageId: 'h1' }, Date.parse('2026-10-27T12:00:00Z'));
    await assignments.restart();
    // The current numbering: more assignments, handled positions, a held
    // delivery assigned then released, and a let-go one.
    const b = await assignments.assign(config, { sequence: 4, roomId: 'b', messageId: 'b1' });
    await assignments.handled(4);
    await assignments.park(
      { sequence: 5, roomId: 'c', messageId: 'c1', event: { t: 'text-c' } },
      true
    );
    const c = await assignments.assign(config, { sequence: 5, roomId: 'c', messageId: 'c1' });
    await assignments.released({ roomId: 'c', messageId: 'c1' }, null);
    await assignments.handled(6);
    await assignments.park(
      { sequence: 7, roomId: 'd', messageId: 'd1', event: { t: 'text-gone' } },
      true
    );
    await assignments.waiting({ roomId: 'd', messageId: 'd1' }, Date.now());
    await assignments.released({ roomId: 'd', messageId: 'd1' }, 'no room in time (timed out)');
    await assignments.park(
      { sequence: 8, roomId: 'e', messageId: 'e1', event: { t: 'text-e' } },
      true
    );
    await assignments.warm(config, 'f');
    const before = {
      cursor: assignments.cursor,
      pending: assignments.pending(),
      placements: assignments.placements(),
      sessions: assignments.sessions(),
      configOfA: assignments.configOf(a.session.sessionId),
      waitingH: assignments.waitingSince({ roomId: 'h', messageId: 'h1' }),
    };
    await assignments.close();
    held.mockRestore();
    const length = assignments.length;
    const dropped = await assignments.compact();
    expect(dropped).toBeGreaterThan(0);
    const reopened = await AgentHostAssignments.open(root);
    expect(reopened.length).toBe(length - dropped);
    expect(reopened.cursor).toBe(before.cursor);
    expect(reopened.pending()).toEqual(before.pending);
    expect(reopened.placements()).toEqual(before.placements);
    expect(reopened.sessions()).toEqual(before.sessions);
    expect(reopened.configOf(a.session.sessionId)).toEqual(before.configOfA);
    expect(reopened.waitingSince({ roomId: 'h', messageId: 'h1' })).toBe(before.waitingH);
    // The same message served again is the session it was already given.
    expect(await reopened.assign(config, { sequence: 4, roomId: 'b', messageId: 'b1' })).toEqual(b);
    expect(await reopened.assign(config, { sequence: 5, roomId: 'c', messageId: 'c1' })).toEqual(c);
    // Finished messages' text is gone; waiting ones' is kept.
    const text = await readFile(join(root, 'assignments.jsonl'), 'utf8');
    for (const gone of ['text-done', 'text-gone', 'text-c']) expect(text).not.toContain(gone);
    for (const kept of ['text-held', 'text-e']) expect(text).toContain(kept);
    // Compacting again finds nothing more to drop.
    expect(await reopened.compact()).toBe(0);
  });

  it('rewrites the journal once for a burst of 20 releases, and the text is gone within seconds', async () => {
    // Compacting on every release would rewrite the journal over
    // and over in a burst; it is debounced to one rewrite.
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-compact-burst-'));
    roots.push(root);
    const assignments = await AgentHostAssignments.open(root);
    const compactions = vi.spyOn(assignments, 'compact');
    for (let i = 1; i <= 20; i++)
      await assignments.park(
        { sequence: i, roomId: `r${i}`, messageId: `m${i}`, event: { t: `burst-text-${i}` } },
        true
      );
    const started = Date.now();
    for (let i = 1; i <= 20; i++)
      await assignments.released({ roomId: `r${i}`, messageId: `m${i}` }, null);
    expect(compactions).not.toHaveBeenCalled();
    const text = () => readFile(join(root, 'assignments.jsonl'), 'utf8');
    while ((await text()).includes('burst-text-') && Date.now() - started < 3000)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await text()).not.toContain('burst-text-');
    expect(compactions).toHaveBeenCalledTimes(1);
    await assignments.close();
    expect(compactions).toHaveBeenCalledTimes(1);
  });

  it('compacts what a release scheduled when the host stops, before letting go of the journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shared-watch-compact-close-'));
    roots.push(root);
    const assignments = await AgentHostAssignments.open(root);
    await assignments.park(
      { sequence: 1, roomId: 'r', messageId: 'm', event: { t: 'closing-text' } },
      true
    );
    await assignments.released({ roomId: 'r', messageId: 'm' }, null);
    await assignments.close();
    expect(await readFile(join(root, 'assignments.jsonl'), 'utf8')).not.toContain('closing-text');
  });

  it('keeps a held message waiting across numberings, and drops it once released', () => {
    const records = [
      { parked: 3, roomId: 'h', messageId: 'h1', spawning: true, event: { t: 'x' } },
      { restarted: true as const, at: 'one' },
      { handled: 2 },
      { restarted: true as const, at: 'two' },
      { handled: 9 },
      { handled: 4 },
    ];
    expect(compactAssignments(records)).toEqual([
      records[0],
      { restarted: true, at: 'two' },
      { handled: 9 },
    ]);
    expect(
      compactAssignments([...records, { released: { roomId: 'h', messageId: 'h1' } }])
    ).toEqual([{ restarted: true, at: 'two' }, { handled: 9 }]);
  });
});
