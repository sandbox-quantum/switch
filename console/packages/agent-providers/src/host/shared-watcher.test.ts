import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as runtime from '@sandboxaq/switch-agent-runtime';
import type { AgentBridgeEvent, SwitchEventStreamDeps } from '@sandboxaq/switch-agent-runtime';
import { afterEach, expect, it, vi } from 'vitest';
import { declareHandoffCapability, HANDOFF_FILE } from './handoff';
import { ensureSharedProcess, type Supervision } from './launch';
import { sharedConfigSchema } from './shared-config';
import {
  replaceSupersededSessions,
  runSharedWatcher,
  SharedWatchAssignments,
} from './shared-watcher';
import { clearTakenOver, recordTakenOver } from './taken-over';

const supervision: Supervision = { build: 'build', start: async () => {}, stop: async () => {} };

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
/**
 * What Switch says about this agent's rooms, and what it was asked.
 *
 * Which session holds a room is the server's answer, so a test states it here
 * rather than writing the files a controller used to infer it from. The rules
 * below are the server's: a room with a live owner is that session's, a room
 * something else already claims takes nothing, and the right to start a session
 * is granted to one message at a time.
 */
const server = vi.hoisted(() => ({
  owners: new Map<string, { sessionId: string; hostId: string; epoch: string }>(),
  claimed: new Set<string>(),
  grants: new Map<string, string>(),
  asked: [] as { roomId: string; messageId: string; sequence: number; spawning: boolean }[],
  reservations: [] as { roomId: string; messageId: string; sequence: number; expired: boolean }[],
  discarded: [] as string[],
  refusals: [] as { code: string; retryable: boolean }[],
  listRefusals: [] as { code: string; retryable: boolean }[],
}));
vi.mock('@sandboxaq/switch-agent-runtime', async (importOriginal) => {
  const original = await importOriginal<typeof runtime>();
  const refuse = (refusal: { code: string; retryable: boolean }) =>
    new original.RoomAdmissionError(refusal.code, 'the server said so.', refusal.retryable);
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
    SwitchRoomAdmissions: class {
      async admit(delivery: {
        roomId: string;
        messageId: string;
        sequence: number;
        spawning: boolean;
      }): Promise<runtime.RoomAdmission> {
        server.asked.push(delivery);
        const refusal = server.refusals.shift();
        if (refusal) throw refuse(refusal);
        const owner = server.owners.get(delivery.roomId);
        if (owner) return { status: 'owner', ...owner };
        if (server.claimed.has(delivery.roomId)) return { status: 'unavailable' };
        const granted = server.grants.get(delivery.roomId);
        if (granted !== undefined && granted !== delivery.messageId)
          return { status: 'unavailable' };
        if (granted === undefined) {
          if (!delivery.spawning) return { status: 'unavailable' };
          server.grants.set(delivery.roomId, delivery.messageId);
        }
        return { status: 'none', grantExpiresAt: new Date(Date.now() + 120000).toISOString() };
      }
      async reservations(): Promise<runtime.RoomReservation[]> {
        const refusal = server.listRefusals.shift();
        if (refusal) throw refuse(refusal);
        return server.reservations.map((entry) => ({ ...entry }));
      }
      async discard(delivery: { roomId: string; messageId: string }): Promise<void> {
        server.discarded.push(`${delivery.roomId}/${delivery.messageId}`);
        server.reservations = server.reservations.filter(
          (entry) => entry.roomId !== delivery.roomId || entry.messageId !== delivery.messageId
        );
      }
    },
  };
});

/** Says the server has this session holding the room. */
function owns(roomId: string, sessionId: string) {
  server.owners.set(roomId, { sessionId, hostId: 'host', epoch: 'epoch' });
  server.claimed.delete(roomId);
  server.grants.delete(roomId);
}

const roots: string[] = [];
afterEach(async () => {
  streams.length = 0;
  declarations.length = 0;
  supervisors.clear();
  server.owners.clear();
  server.claimed.clear();
  server.grants.clear();
  server.asked.length = 0;
  server.reservations.length = 0;
  server.discarded.length = 0;
  server.refusals.length = 0;
  server.listRefusals.length = 0;
  vi.mocked(ensureSharedProcess).mockReset();
  vi.restoreAllMocks();
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
    // Spent on the session's first claim, so it is created already holding the
    // room the server granted it.
    expect(first.grant).toEqual({ roomId: 'room', messageId: 'message' });
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
    expect(another.grant).toEqual({ roomId: 'another', messageId: 'second' });
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

/**
 * A session of the same agent on disk, which the server can then be said to
 * have holding a room. `reads` is whether its worker was built to take what the
 * controller routes to it; one that was not is still serving itself from a
 * connection of its own.
 */
async function existing(
  root: string,
  config: ReturnType<typeof watchable>,
  reads: boolean
): Promise<{ sessionId: string; sessionRoot: string }> {
  const saved = structuredClone(config);
  saved.session = { ...saved.session, sessionId: randomUUID() };
  const sessionRoot = join(root, saved.session.sessionId);
  await mkdir(sessionRoot, { recursive: true });
  await writeFile(join(sessionRoot, 'config.json'), JSON.stringify(saved));
  if (reads) await declareHandoffCapability(sessionRoot);
  return { sessionId: saved.session.sessionId, sessionRoot };
}

it('stays down while a takeover marker says another client holds the connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-taken-over-'));
  roots.push(root);
  paths.root = root;
  await writeFlags(root, { enabled: true, spawn: true });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

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
async function eventually(reached: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (reached()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The watcher never reached the state this test was waiting for.');
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
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: true });

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
  vi.mocked(ensureSharedProcess).mockImplementation(async ({ config: launched }) => {
    started.push(launched.session.sessionId);
    if (started.length === 1) await held;
    return { created: true };
  });

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
  // Switch grants the room to one of the two messages and holds the other until
  // the session it started is answering the room.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-concurrent-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const started: string[] = [];
  vi.mocked(ensureSharedProcess).mockImplementation(async ({ config: launched }) => {
    started.push(launched.session.sessionId);
    return { created: true };
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await Promise.all([
      streams[0]!.onEvent!(addressed(1, 'room')),
      streams[0]!.onEvent!(addressed(2, 'room')),
    ]);
  } finally {
    abort.abort();
    await run;
  }

  const journal = await SharedWatchAssignments.open(root);
  expect(journal.sessions()).toHaveLength(1);
  expect(new Set(started).size).toBe(1);
  expect(journal.pending()).toEqual([
    { sequence: 2, roomId: 'room', messageId: 'message-2', spawning: true },
  ]);
});

it('routes to the worker that reads handoffs and says so when one does not', async () => {
  // One agent, two sessions, one of them on a bundle from before handoffs. The
  // older worker must keep serving itself: nothing else would admit an event
  // written to an inbox it never reads, and an event nobody admits would be
  // lost in silence rather than refused.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-handoff-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const capable = await existing(root, config, true);
  const legacy = await existing(root, config, false);
  owns('reads-handoffs', capable.sessionId);
  owns('older-bundle', legacy.sessionId);
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: true });
  const failure = vi.spyOn(console, 'error').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(3, 'reads-handoffs'));
    await streams[0]!.onEvent!(addressed(4, 'older-bundle'));
  } finally {
    abort.abort();
    await run;
  }

  const handoffs = async (sessionRoot: string) =>
    await readFile(join(sessionRoot, HANDOFF_FILE), 'utf8').catch(() => null);
  expect(await handoffs(capable.sessionRoot)).toBe(
    JSON.stringify({ sequence: 3, roomId: 'reads-handoffs', messageId: 'message-3' }) + '\n'
  );
  expect(await handoffs(legacy.sessionRoot)).toBeNull();
  expect(failure.mock.calls.at(-1)?.[0]).toContain(legacy.sessionId);
  // Neither room started a session: the server named one that is already
  // running, and this controller does not second-guess it.
  expect(ensureSharedProcess).not.toHaveBeenCalled();
  expect((await SharedWatchAssignments.open(root)).sessions()).toEqual([]);
  // Both routing decisions are recorded, so a watcher restarted here reopens
  // past them rather than handing the same two events over again.
  expect((await SharedWatchAssignments.open(root)).cursor).toBe(4);
});

it('still owes an event its worker could not be handed', async () => {
  // The handoff is the only copy of where a routed event was going. Recording
  // the event as dealt with before that write lands would step the watcher over
  // it on restart, and nothing would be holding it.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-route-fails-'));
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
  await mkdir(sessionRoot, { recursive: true });
  await declareHandoffCapability(sessionRoot);
  // A directory where the inbox goes: the worker reads handoffs and none can be
  // written to it.
  await mkdir(join(sessionRoot, HANDOFF_FILE));
  owns('room', assigned.session.sessionId);
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: true });

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await expect(streams[0]!.onEvent!(addressed(2, 'room'))).rejects.toThrow();
  } finally {
    abort.abort();
    await run.catch(() => {});
  }

  expect((await SharedWatchAssignments.open(root)).cursor).toBe(1);
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
  // The restore starts its sessions one at a time, so the setting can change
  // while it is part way through and the loop itself never sees it.
  vi.mocked(ensureSharedProcess).mockImplementation(async ({ config: launched }) => {
    started.push(launched.session.sessionId);
    if (started.length === 1) await stopSpawning(root);
    return { created: true };
  });

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
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

  await replaceSupersededSessions(agentId, 'agent-controller', {
    build: '/host/shared-host-new.mjs',
    start: vi.fn(),
    stop: vi.fn(),
  });

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

  await expect(
    replaceSupersededSessions(agentId, {
      build: '/host/shared-host-new.mjs',
      start: vi.fn(),
      stop: vi.fn(),
    })
  ).resolves.toBeUndefined();

  // This agent's own session is still picked up, which is the whole point.
  expect(vi.mocked(ensureSharedProcess).mock.calls.map((call) => call[0].root)).toEqual([
    join(root, 'mine'),
  ]);
  // Skipped, but never in silence.
  expect(warn.mock.calls.map(String).join('\n')).toContain('stale');
  warn.mockRestore();
});

it('hands a room its own live session even with spawning turned off', async () => {
  // Spawning off means no new session, not a deaf agent: a room somebody is
  // already sitting in keeps getting its messages. A room with nobody in it is
  // held rather than dropped, and said so.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-no-spawn-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const live = await existing(root, config, true);
  owns('room', live.sessionId);
  await stopSpawning(root);
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: true });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(2, 'room'));
    await streams[0]!.onEvent!(addressed(3, 'unattended'));
  } finally {
    abort.abort();
    await run;
  }

  expect(await readFile(join(live.sessionRoot, HANDOFF_FILE), 'utf8')).toBe(
    JSON.stringify({ sequence: 2, roomId: 'room', messageId: 'message-2' }) + '\n'
  );
  expect(ensureSharedProcess).not.toHaveBeenCalled();
  expect(warning.mock.calls.at(-1)?.[0]).toContain('holding them until one can');
  const journal = await SharedWatchAssignments.open(root);
  expect(journal.sessions()).toEqual([]);
  expect(journal.pending()).toEqual([
    { sequence: 3, roomId: 'unattended', messageId: 'message-3', spawning: false },
  ]);
  // Behind the held event, so a controller restarted here is served it again
  // rather than stepping over a message nothing has answered.
  expect(journal.cursor).toBe(2);
});

it('holds a room nothing can take yet instead of starting a second session', async () => {
  // The session that took the room is still starting, or the one that had it
  // has not finished letting go. Either way the room is spoken for, and
  // starting a session for it would talk over the one that has it.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-undecided-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const taker = await existing(root, config, true);
  server.claimed.add('room');
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: true });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(5, 'room'));
    expect(ensureSharedProcess).not.toHaveBeenCalled();
    expect((await SharedWatchAssignments.open(root)).sessions()).toEqual([]);
    expect(warning.mock.calls.at(-1)?.[0]).toContain('holding them until one can');

    // Held, and said so. Nothing has been dealt with, so a watcher that dies
    // here reopens where it started rather than past the event it is holding.
    expect((await SharedWatchAssignments.open(root)).cursor).toBe(0);

    // Another room is dealt with while that one waits — and the position stops
    // behind the held event rather than running on to the answered one.
    await streams[0]!.onEvent!(addressed(6, 'other'));
    expect((await SharedWatchAssignments.open(root)).sessions()).toHaveLength(1);
    expect((await SharedWatchAssignments.open(root)).cursor).toBe(4);

    // The session that took the room is answering it now, and what was held
    // goes there — in the order it arrived, and to the session that had it all
    // along rather than one started to take it over.
    owns('room', taker.sessionId);
    const [other] = (await SharedWatchAssignments.open(root)).sessions();
    owns('other', other!.session.sessionId);
    await streams[0]!.onEvent!(addressed(7, 'other'));
  } finally {
    abort.abort();
    await run;
  }

  expect(await readFile(join(taker.sessionRoot, HANDOFF_FILE), 'utf8')).toBe(
    JSON.stringify({ sequence: 5, roomId: 'room', messageId: 'message-5' }) + '\n'
  );
  const journal = await SharedWatchAssignments.open(root);
  expect(journal.sessions()).toHaveLength(1);
  expect(journal.pending()).toEqual([]);
  expect(journal.cursor).toBe(7);
});

it('delivers what it was holding after a restart the server never replays', async () => {
  // The held event is the server's to serve again only while its buffer still
  // has it. A controller that restarted after a trim, or after the buffer was
  // renumbered, would otherwise have let the message go.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-held-restart-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const taker = await existing(root, config, true);
  server.claimed.add('room');
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: true });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const first = new AbortController();
  const held = runSharedWatcher(root, config, first.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(5, 'room'));
  } finally {
    first.abort();
    await held;
  }
  expect((await SharedWatchAssignments.open(root)).pending()).toEqual([
    { sequence: 5, roomId: 'room', messageId: 'message-5', spawning: true },
  ]);

  // The sibling is answering the room while nothing is watching, and the
  // controller comes back to a stream that serves it nothing at all.
  owns('room', taker.sessionId);
  const second = new AbortController();
  const resumed = runSharedWatcher(root, config, second.signal, supervision);
  try {
    await eventually(() => streams.length === 2);
  } finally {
    second.abort();
    await resumed;
  }

  expect(await readFile(join(taker.sessionRoot, HANDOFF_FILE), 'utf8')).toBe(
    JSON.stringify({ sequence: 5, roomId: 'room', messageId: 'message-5' }) + '\n'
  );
  expect(warning.mock.calls.map((call) => String(call[0]))).toContainEqual(
    expect.stringContaining('when this controller last stopped')
  );
  const journal = await SharedWatchAssignments.open(root);
  expect(journal.pending()).toEqual([]);
  expect(journal.cursor).toBe(5);
});

it('starts the session a held event was promised after spawning is turned off', async () => {
  // The room was addressed while the agent was allowed to start a session, and
  // it waited only because the room was spoken for. The permission belongs to
  // the message, not to the controller that finally admits it.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-held-permission-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  server.claimed.add('room');
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const first = new AbortController();
  const parked = runSharedWatcher(root, config, first.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(5, 'room'));
  } finally {
    first.abort();
    await parked;
  }

  // Whatever was holding the room has let it go, and automatic sessions are
  // switched off in the meantime.
  server.claimed.delete('room');
  await stopSpawning(root);
  const second = new AbortController();
  const resumed = runSharedWatcher(root, config, second.signal, supervision);
  try {
    await eventually(() => streams.length === 2);
  } finally {
    second.abort();
    await resumed;
  }

  expect(server.asked.at(-1)).toMatchObject({ messageId: 'message-5', spawning: true });
  const journal = await SharedWatchAssignments.open(root);
  expect(journal.pending()).toEqual([]);
  const started = journal.sessions();
  expect(started).toHaveLength(1);
  expect(await readFile(join(root, started[0]!.session.sessionId, HANDOFF_FILE), 'utf8')).toBe(
    JSON.stringify({ sequence: 5, roomId: 'room', messageId: 'message-5' }) + '\n'
  );
});

it('takes a held event served again by a reopened stream as the one it already holds', async () => {
  // The stream reopens behind a held event, so the server offers it once more
  // while this controller is still holding its own copy. One message.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-held-again-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const taker = await existing(root, config, true);
  server.claimed.add('room');
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const first = new AbortController();
  const parked = runSharedWatcher(root, config, first.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(5, 'room'));
  } finally {
    first.abort();
    await parked;
  }

  const second = new AbortController();
  const resumed = runSharedWatcher(root, config, second.signal, supervision);
  try {
    await eventually(() => streams.length === 2);
    await streams[1]!.onEvent!(addressed(5, 'room'));
    owns('room', taker.sessionId);
    await streams[1]!.onEvent!(addressed(6, 'other'));
  } finally {
    second.abort();
    await resumed;
  }

  expect(await readFile(join(taker.sessionRoot, HANDOFF_FILE), 'utf8')).toBe(
    JSON.stringify({ sequence: 5, roomId: 'room', messageId: 'message-5' }) + '\n'
  );
  expect((await SharedWatchAssignments.open(root)).pending()).toEqual([]);
});

it('holds a delivery Switch could not be asked about rather than dropping it', async () => {
  // A room that cannot be asked about is not a room with no owner. Treating the
  // two the same either loses the message or starts a session beside the one
  // already answering it.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-unreachable-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const live = await existing(root, config, true);
  server.refusals.push({ code: 'UNREACHABLE', retryable: true });
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: true });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
    expect(ensureSharedProcess).not.toHaveBeenCalled();
    expect(warning.mock.calls.map((call) => String(call[0]))).toContainEqual(
      expect.stringContaining('held until it can')
    );

    // Switch answers the next time it is asked, and the message that waited is
    // delivered rather than having been dropped while it was unreachable.
    owns('room', live.sessionId);
    await streams[0]!.onEvent!(addressed(2, 'other'));
  } finally {
    abort.abort();
    await run;
  }

  expect(await readFile(join(live.sessionRoot, HANDOFF_FILE), 'utf8')).toBe(
    JSON.stringify({ sequence: 1, roomId: 'room', messageId: 'message-1' }) + '\n'
  );
  expect((await SharedWatchAssignments.open(root)).pending()).toEqual([]);
});

it('gives up loudly on a delivery Switch refuses for what it is', async () => {
  // Refused for what it is rather than for when it was asked, so waiting
  // answers the same. Held for ever it would be a room gone quiet with nothing
  // saying why.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-refused-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  server.refusals.push({ code: 'NOT_FOUND', retryable: false });
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: true });
  const failure = vi.spyOn(console, 'error').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
  } finally {
    abort.abort();
    await run;
  }

  expect(failure.mock.calls.at(-1)?.[0]).toContain('It is not being delivered.');
  expect(ensureSharedProcess).not.toHaveBeenCalled();
  const journal = await SharedWatchAssignments.open(root);
  expect(journal.pending()).toEqual([]);
  expect(journal.sessions()).toEqual([]);
  expect(journal.cursor).toBe(1);
});

it('delivers a message Switch is still holding that nothing here remembers', async () => {
  // Routed is not delivered: the session an event was handed to can lose the
  // room or stop before it submits, and a controller can restart between
  // routing an event and anything admitting it. Switch keeps the verified copy
  // until a session commits it, and this is what finds those again.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-reserved-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const live = await existing(root, config, true);
  owns('room', live.sessionId);
  server.reservations.push({
    roomId: 'room',
    messageId: 'message-9',
    sequence: 9,
    expired: false,
  });
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: true });

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
  } finally {
    abort.abort();
    await run;
  }

  expect(await readFile(join(live.sessionRoot, HANDOFF_FILE), 'utf8')).toBe(
    JSON.stringify({ sequence: 9, roomId: 'room', messageId: 'message-9' }) + '\n'
  );
  expect((await SharedWatchAssignments.open(root)).pending()).toEqual([]);
});

it('gives up a delivery Switch has stopped promising, and says so', async () => {
  // Expiry stops the server promising the delivery; the copy goes when this
  // controller says it has stopped holding it. Nobody is told by the server, so
  // the message is reported here or it disappears in silence.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-expired-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  server.claimed.add('room');
  server.reservations.push({ roomId: 'room', messageId: 'message-5', sequence: 5, expired: true });
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const failure = vi.spyOn(console, 'error').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    // Held locally as well, and given up on both sides rather than left waiting
    // for an answer the server will never be able to build.
    await streams[0]!.onEvent!(addressed(5, 'room'));
    await eventually(() => server.discarded.length === 1);
  } finally {
    abort.abort();
    await run;
  }

  expect(failure.mock.calls.at(-1)?.[0]).toContain('will not be delivered');
  expect(server.discarded).toEqual(['room/message-5']);
  expect((await SharedWatchAssignments.open(root)).pending()).toEqual([]);
});

it('keeps serving rooms when Switch cannot say what it is still holding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-sweep-fails-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const live = await existing(root, config, true);
  owns('room', live.sessionId);
  server.listRefusals.push({ code: 'UNREACHABLE', retryable: true });
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: true });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
  } finally {
    abort.abort();
    await run;
  }

  expect(warning.mock.calls.map((call) => String(call[0]))).toContainEqual(
    expect.stringContaining('could not be asked what it is still holding')
  );
  expect(await readFile(join(live.sessionRoot, HANDOFF_FILE), 'utf8')).toBe(
    JSON.stringify({ sequence: 1, roomId: 'room', messageId: 'message-1' }) + '\n'
  );
});

it('keeps held deliveries through a renumbering without letting their old positions count', async () => {
  // A held event outlives the numbering it arrived on. The sequence it carries
  // then belongs to somebody else's message, so it decides neither where the
  // stream reopens nor whether the delivery is one already seen.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-held-renumbered-'));
  roots.push(root);
  paths.root = root;
  const config = template(root);
  const assignments = await SharedWatchAssignments.open(root);
  await assignments.park({ sequence: 4, roomId: 'room', messageId: 'held-first' }, true);
  await assignments.park({ sequence: 900, roomId: 'room', messageId: 'held-second' }, true);
  expect(assignments.cursor).toBe(0);

  await assignments.restart();
  const reloaded = await SharedWatchAssignments.open(root);
  expect(reloaded.cursor).toBe(0);
  expect(reloaded.pending()).toEqual([
    { sequence: 4, roomId: 'room', messageId: 'held-first', spawning: true },
    { sequence: 900, roomId: 'room', messageId: 'held-second', spawning: true },
  ]);

  const fresh = await reloaded.assign(config, { sequence: 4, roomId: 'other', messageId: 'c' });
  await reloaded.handled(4);
  expect(reloaded.cursor).toBe(4);

  // Position 4 is that message's now. The held one is still recognised, and is
  // neither refused as a changed identity nor mistaken for a duplicate of it.
  const owner = await reloaded.assign(config, {
    sequence: 4,
    roomId: 'room',
    messageId: 'held-first',
  });
  expect(owner.session.sessionId).not.toBe(fresh.session.sessionId);
  await reloaded.released({ roomId: 'room', messageId: 'held-first' });
  await reloaded.assign(config, { sequence: 900, roomId: 'room', messageId: 'held-second' });
  await reloaded.released({ roomId: 'room', messageId: 'held-second' });

  expect(reloaded.pending()).toEqual([]);
  // Nine hundred was a position under a numbering that is gone; the stream
  // reopens where this one actually reached.
  expect(reloaded.cursor).toBe(4);
  await reloaded.assign(config, { sequence: 5, roomId: 'other', messageId: 'next' });
  await reloaded.handled(5);
  expect(reloaded.cursor).toBe(5);
});

it('hands a session it has just created the event that created it', async () => {
  // Nothing else carries that message: the session has no connection of its
  // own, and it is being started precisely because somebody addressed the room.
  // The worker cannot have said it reads handoffs yet — it does not exist.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-first-event-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const started: { sessionId: string; handedOver: string }[] = [];
  vi.mocked(ensureSharedProcess).mockImplementation(async ({ config: launched }) => {
    started.push({
      sessionId: launched.session.sessionId,
      handedOver: await readFile(
        join(root, launched.session.sessionId, HANDOFF_FILE),
        'utf8'
      ).catch(() => ''),
    });
    return { created: true };
  });

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
  } finally {
    abort.abort();
    await run;
  }

  const [assigned] = (await SharedWatchAssignments.open(root)).sessions();
  expect(started.map((entry) => entry.sessionId)).toEqual([assigned!.session.sessionId]);
  expect(started[0]!.handedOver).toBe(
    JSON.stringify({ sequence: 1, roomId: 'room', messageId: 'message-1' }) + '\n'
  );
  // The session is created already holding the room it was started to answer.
  expect(assigned!.grant).toEqual({ roomId: 'room', messageId: 'message-1' });
});
