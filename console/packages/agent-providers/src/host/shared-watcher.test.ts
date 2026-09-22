import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type * as runtime from '@sandboxaq/switch-agent-runtime';
import type { AgentBridgeEvent, SwitchEventStreamDeps } from '@sandboxaq/switch-agent-runtime';
import { afterEach, expect, it, vi } from 'vitest';
import { CAPABILITY_FILE, declareHandoffCapability, HANDOFF_FILE } from './handoff';
import { ensureSharedProcess, type Supervision } from './launch';
import { SharedRoomInbox } from './room-inbox';
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
vi.mock('@sandboxaq/switch-agent-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof runtime>()),
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
}));

const roots: string[] = [];
afterEach(async () => {
  streams.length = 0;
  declarations.length = 0;
  vi.mocked(ensureSharedProcess).mockReset();
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
    const first = await decided(opened, template, event);
    await opened.handled(event.sequence);
    const restarted = await SharedWatchAssignments.open(root);
    expect(restarted.cursor).toBe(7);
    expect(await decided(restarted, template, event)).toEqual(first);
    expect(
      await decided(restarted, template, { ...event, sequence: 8, messageId: 'next' })
    ).toEqual(first);
    expect(restarted.sessions()).toHaveLength(1);
    // Every session an agent has is reached over the one connection the
    // controller holds, so an assignment inherits it rather than minting one.
    expect(first.roomConnection).toEqual(template.roomConnection);
    expect(first.start.input.env).toEqual({
      TEST_SETTING: 'preserved',
      SWITCHDASH_SESSION_ID: first.session.sessionId,
    });
    await expect(decided(restarted, template, { ...event, messageId: 'forged' })).rejects.toThrow(
      'identity'
    );
    const another = await decided(restarted, template, {
      ...event,
      sequence: 9,
      roomId: 'another',
    });
    expect(another.session.sessionId).not.toBe(first.session.sessionId);
    const firstRoot = join(root, first.session.sessionId);
    await mkdir(firstRoot, { recursive: true });
    await writeFile(
      join(firstRoot, 'room-inbox.jsonl'),
      JSON.stringify({ type: 'rooms', rooms: ['another'] }) + '\n'
    );
    const returned = await decided(restarted, template, {
      ...event,
      sequence: 10,
      messageId: 'returned',
    });
    expect(returned.session.sessionId).not.toBe(first.session.sessionId);
    expect(await decided(restarted, template, event)).toEqual(first);
    const returnedRoot = join(root, returned.session.sessionId);
    await mkdir(returnedRoot, { recursive: true });
    await writeFile(join(returnedRoot, 'room-inbox.jsonl'), '{');
    await expect(
      decided(restarted, template, { ...event, sequence: 11, messageId: 'after-crash' })
    ).rejects.toThrow('incomplete record');
    // Nine, not ten: the tenth was assigned and never routed, so it is the one
    // event this journal still owes.
    expect(restarted.cursor).toBe(9);
  }
);

it('keeps a room with the session it started for it until the server moves that session', async () => {
  // A session's rooms are registered when the agent inside it connects to the
  // room, which it cannot have done before the message that started it
  // arrives. Reading the empty answer as "serves nothing" would start a second
  // session for the room on its second message.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-unregistered-'));
  roots.push(root);
  paths.root = root;
  const config = template(root);
  const assignments = await SharedWatchAssignments.open(root);
  const first = await decided(assignments, config, {
    sequence: 1,
    roomId: 'room',
    messageId: 'first',
  });
  const inbox = join(root, first.session.sessionId, 'room-inbox.jsonl');
  await writeFile(inbox, JSON.stringify({ type: 'rooms', rooms: [] }) + '\n');
  expect(
    (await decided(assignments, config, { sequence: 2, roomId: 'room', messageId: 'second' }))
      .session.sessionId
  ).toBe(first.session.sessionId);

  // Once the server has it serving somewhere else, it is not this room's: the
  // event would sit in an inbox that never admits it.
  await writeFile(inbox, JSON.stringify({ type: 'rooms', rooms: ['elsewhere'] }) + '\n');
  expect(
    (await decided(assignments, config, { sequence: 3, roomId: 'room', messageId: 'third' }))
      .session.sessionId
  ).not.toBe(first.session.sessionId);
});

it('stops serving a room with the session the server has taken it from', async () => {
  // A sibling binding the same room evicts this session from it, leaving it
  // with no rooms — the same answer a session that has never been given one
  // gives, and the opposite meaning. The room's new session need not have
  // written anything down yet, so the eviction has to be read off the session
  // that lost the room rather than off the one that took it.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-evicted-'));
  roots.push(root);
  paths.root = root;
  const config = template(root);
  const assignments = await SharedWatchAssignments.open(root);
  const first = await decided(assignments, config, {
    sequence: 1,
    roomId: 'room',
    messageId: 'first',
  });
  const sessionRoot = join(root, first.session.sessionId);
  await writeFile(join(sessionRoot, 'config.json'), JSON.stringify(first));
  const inbox = await SharedRoomInbox.open(sessionRoot);
  await inbox.serves(['room']);
  await inbox.serves([]);
  // The sibling that took the room, running and not yet answered about it.
  const sibling = structuredClone(config);
  sibling.session = { ...sibling.session, sessionId: randomUUID() };
  const siblingRoot = join(root, sibling.session.sessionId);
  await mkdir(siblingRoot, { recursive: true });
  await writeFile(join(siblingRoot, 'config.json'), JSON.stringify(sibling));

  // Undecided rather than free: reading the evicted session's empty answer as
  // an empty room is what starts a second session for one that already has one.
  expect(await assignments.serving(config.session.agentId, 'room')).toBe('undecided');

  // Read from the journal rather than from memory, so a watcher that restarts
  // between the eviction and the next message answers the same way. Restarting
  // the evicted session does not launder it either — the room it was once given
  // and no longer holds is what says the room was taken.
  await (await SharedRoomInbox.open(sessionRoot)).serves([]);
  expect(
    await (await SharedWatchAssignments.open(root)).serving(config.session.agentId, 'room')
  ).toBe('undecided');

  // Once the sibling answers, the room is its own and the event goes there.
  await (await SharedRoomInbox.open(siblingRoot)).serves(['room']);
  expect((await assignments.serving(config.session.agentId, 'room')) as typeof first).toMatchObject(
    {
      session: { sessionId: sibling.session.sessionId },
    }
  );
});

it('frees a room taken from a session once nothing is left running to hold it', async () => {
  // Undecided is a room whose owner has not spoken yet, not a room to be held
  // for ever. With no session of the agent running, nothing can be holding it
  // silently and the next message for it may start one.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-abandoned-'));
  roots.push(root);
  paths.root = root;
  const config = template(root);
  const assignments = await SharedWatchAssignments.open(root);
  const first = await decided(assignments, config, {
    sequence: 1,
    roomId: 'room',
    messageId: 'first',
  });
  const sessionRoot = join(root, first.session.sessionId);
  await writeFile(join(sessionRoot, 'config.json'), JSON.stringify(first));
  const inbox = await SharedRoomInbox.open(sessionRoot);
  await inbox.serves(['room']);
  await inbox.serves([]);
  expect(await assignments.serving(config.session.agentId, 'room')).toBeNull();
});

it('reaches an upgraded session over the controller, not the connection it used to open', async () => {
  // A config saved before the agent had one inbound connection names the
  // session's own. That session stops opening it as soon as it runs this
  // build, so binding to it would name a connection that never returns.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-upgraded-'));
  roots.push(root);
  paths.root = root;
  const config = template(root);
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
  const sessionRoot = join(root, saved.session.sessionId);
  await mkdir(sessionRoot, { recursive: true });
  await writeFile(
    join(sessionRoot, 'room-inbox.jsonl'),
    JSON.stringify({ type: 'rooms', rooms: ['room'] }) + '\n'
  );

  const assignments = await SharedWatchAssignments.open(root);
  const next = await decided(assignments, config, {
    sequence: 2,
    roomId: 'room',
    messageId: 'second',
  });
  expect(next.session.sessionId).toBe(saved.session.sessionId);
  expect(next.roomConnection).toEqual(config.roomConnection);
  // Corrected in the journal too, so a restore launches it over the controller
  // rather than handing the old identity back.
  expect(
    (await SharedWatchAssignments.open(root))
      .sessions()
      .map((entry) => entry.roomConnection?.connectionId)
  ).toEqual([config.roomConnection?.connectionId]);
});

/** An assignment for a room whose owner the watcher could settle. */
async function decided(
  assignments: SharedWatchAssignments,
  config: ReturnType<typeof template>,
  event: { sequence: number; roomId: string; messageId: string }
) {
  const assigned = await assignments.assign(config, event);
  if (assigned === 'undecided')
    throw new Error(`This assignment was expected to settle room ${event.roomId}.`);
  return assigned;
}

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
  const routed = await decided(assignments, config, {
    sequence: 4,
    roomId: 'room',
    messageId: 'four',
  });
  await assignments.handled(4);
  // Assigned, and then the watcher dies before the session is handed the event.
  const unrouted = await decided(assignments, config, {
    sequence: 6,
    roomId: 'other',
    messageId: 'six',
  });

  const restarted = await SharedWatchAssignments.open(root);
  expect(restarted.cursor).toBe(4);
  // Redelivery finds the same session, so the event is routed where it was
  // always going rather than to a second one.
  expect(
    await decided(restarted, config, { sequence: 6, roomId: 'other', messageId: 'six' })
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
    await decided(older, config, { sequence, roomId, messageId: `m${sequence}` });

  // Six, because the watcher only assigns the next event once the one before it
  // has been routed — so only the last record is still owed.
  expect((await SharedWatchAssignments.open(root)).cursor).toBe(6);
});

it('resumes at the server head after its numbering restarts, keeping room sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-restart-'));
  roots.push(root);
  paths.root = root;
  const config = template(root);
  const assignments = await SharedWatchAssignments.open(root);
  const before = await decided(assignments, config, {
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
  const after = await decided(reloaded, config, {
    sequence: 2,
    roomId: 'other',
    messageId: 'after',
  });
  expect(after.session.sessionId).not.toBe(before.session.sessionId);
  await reloaded.handled(2);
  expect(reloaded.cursor).toBe(2);

  // The room keeps the session it already had.
  expect(
    await decided(reloaded, config, { sequence: 3, roomId: 'room', messageId: 'again' })
  ).toEqual(before);
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
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-concurrent-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const started: string[] = [];
  vi.mocked(ensureSharedProcess).mockImplementation(async ({ config: launched }) => {
    started.push(launched.session.sessionId);
    return { created: true };
  });

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

  expect((await SharedWatchAssignments.open(root)).sessions()).toHaveLength(1);
  expect(new Set(started).size).toBe(1);
});

it('routes to the worker that reads handoffs and leaves the older one to its own connection', async () => {
  // One agent, two sessions, one of them on a bundle from before handoffs. The
  // older worker must keep serving itself: nothing else would admit an event
  // written to an inbox it never reads, and an event nobody admits is lost in
  // silence rather than refused.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-handoff-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const assignments = await SharedWatchAssignments.open(root);
  const capable = await decided(assignments, config, {
    sequence: 1,
    roomId: 'reads-handoffs',
    messageId: 'first',
  });
  const legacy = await decided(assignments, config, {
    sequence: 2,
    roomId: 'older-bundle',
    messageId: 'first',
  });
  const sessionRoot = (assigned: typeof capable) => join(root, assigned.session.sessionId);
  // The older bundle's session says nothing about handoffs, as one assigned by
  // an app that gave every session a connection of its own never did.
  await rm(join(sessionRoot(legacy), CAPABILITY_FILE));

  // What each session was handed at the moment it was started, so the order of
  // the two is asserted rather than only the outcome: a controller that starts
  // the worker first can die before the event it decided on is anywhere.
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
    await streams[0]!.onEvent!(addressed(3, 'reads-handoffs'));
    await streams[0]!.onEvent!(addressed(4, 'older-bundle'));
  } finally {
    abort.abort();
    await run;
  }

  const handoffs = async (assigned: typeof capable) =>
    await readFile(join(sessionRoot(assigned), HANDOFF_FILE), 'utf8').catch(() => null);
  expect(await handoffs(capable)).toBe(
    JSON.stringify({ sequence: 3, roomId: 'reads-handoffs', messageId: 'message-3' }) + '\n'
  );
  expect(await handoffs(legacy)).toBeNull();
  // Neither is starved: both keep the session their room already had, and both
  // are started for the event addressed to them.
  expect(started.map((entry) => entry.sessionId)).toEqual([
    capable.session.sessionId,
    legacy.session.sessionId,
    capable.session.sessionId,
    legacy.session.sessionId,
  ]);
  expect(started.at(-2)?.handedOver).toContain('message-3');
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
  const assigned = await decided(assignments, config, {
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
  const first = await decided(assignments, config, {
    sequence: 1,
    roomId: 'room',
    messageId: 'first',
  });
  await decided(assignments, config, { sequence: 2, roomId: 'other', messageId: 'second' });
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
  supervisors.clear();
  vi.mocked(ensureSharedProcess).mockClear();
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
  // already sitting in keeps getting its messages.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-no-spawn-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const assignments = await SharedWatchAssignments.open(root);
  const assigned = await decided(assignments, config, {
    sequence: 1,
    roomId: 'room',
    messageId: 'first',
  });
  await assignments.handled(1);
  const sessionRoot = join(root, assigned.session.sessionId);
  await mkdir(sessionRoot, { recursive: true });
  await declareHandoffCapability(sessionRoot);
  await writeFile(
    join(sessionRoot, 'room-inbox.jsonl'),
    JSON.stringify({ type: 'rooms', rooms: ['room'] }) + '\n'
  );
  await stopSpawning(root);
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: true });

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

  expect(await readFile(join(sessionRoot, HANDOFF_FILE), 'utf8')).toBe(
    JSON.stringify({ sequence: 2, roomId: 'room', messageId: 'message-2' }) + '\n'
  );
  expect(ensureSharedProcess).not.toHaveBeenCalled();
  // The room with nobody in it is answered by nobody, and the watcher moves on
  // rather than holding the event for a session that will not be started.
  expect((await SharedWatchAssignments.open(root)).sessions()).toHaveLength(1);
  expect((await SharedWatchAssignments.open(root)).cursor).toBe(3);
});

it('hands a room to a session started outside its journal rather than starting a second one', async () => {
  // A session somebody opened from Console is in no assignment journal and has
  // no connection of its own, so the controller is the only thing that can
  // reach it — and a room it is already answering must not get a second session
  // talking over it.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-outside-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const opened = structuredClone(config);
  opened.session = { ...opened.session, sessionId: randomUUID() };
  const sessionRoot = join(root, opened.session.sessionId);
  await mkdir(sessionRoot, { recursive: true });
  await writeFile(join(sessionRoot, 'config.json'), JSON.stringify(opened));
  await declareHandoffCapability(sessionRoot);
  // The rooms the server answered its binding with, which is the only claim on
  // a room the watcher trusts.
  await writeFile(
    join(sessionRoot, 'room-inbox.jsonl'),
    JSON.stringify({ type: 'rooms', rooms: ['room'] }) + '\n'
  );
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: false });

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(1, 'room'));
  } finally {
    abort.abort();
    await run;
  }

  expect(await readFile(join(sessionRoot, HANDOFF_FILE), 'utf8')).toBe(
    JSON.stringify({ sequence: 1, roomId: 'room', messageId: 'message-1' }) + '\n'
  );
  expect(
    (await SharedWatchAssignments.open(root)).sessions().map((entry) => entry.session.sessionId)
  ).toEqual([opened.session.sessionId]);
  // Ensured, not created: the session is already running, and the launch is the
  // same idempotent call every assignment makes.
  expect(vi.mocked(ensureSharedProcess).mock.calls.map((call) => call[0].root)).toEqual([
    sessionRoot,
  ]);
});

/**
 * A session of the same agent on disk, answered with each set of rooms in turn.
 * No answers at all is a session the server has yet to tell anything, which is
 * not the same as one told it holds none.
 */
async function answering(
  root: string,
  template: ReturnType<typeof watchable>,
  rooms: string[][]
): Promise<string> {
  const saved = structuredClone(template);
  saved.session = { ...saved.session, sessionId: randomUUID() };
  const sessionRoot = join(root, saved.session.sessionId);
  await mkdir(sessionRoot, { recursive: true });
  await writeFile(join(sessionRoot, 'config.json'), JSON.stringify(saved));
  await declareHandoffCapability(sessionRoot);
  const inbox = await SharedRoomInbox.open(sessionRoot);
  for (const answer of rooms) await inbox.serves(answer);
  return sessionRoot;
}

it('holds a room whose owner is undecided instead of starting a second session', async () => {
  // The session that took the room binds it before it writes anything down, so
  // for a moment nothing local names an owner. Treating that as an empty room
  // starts a session that then talks over the one already answering it.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-undecided-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  // The session the room was taken from, and the running sibling that took it
  // and has not been answered about it yet.
  await answering(root, config, [['room'], []]);
  const taker = await answering(root, config, []);
  vi.mocked(ensureSharedProcess).mockResolvedValue({ created: true });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const abort = new AbortController();
  const run = runSharedWatcher(root, config, abort.signal, supervision);
  try {
    await eventually(() => streams.length === 1);
    await streams[0]!.onEvent!(addressed(5, 'room'));
    expect(ensureSharedProcess).not.toHaveBeenCalled();
    expect((await SharedWatchAssignments.open(root)).sessions()).toEqual([]);
    expect(warning.mock.calls.at(-1)?.[0]).toContain('holding its messages');

    // Held, and said so. Nothing has been dealt with, so a watcher that dies
    // here reopens where it started rather than past the event it is holding.
    expect((await SharedWatchAssignments.open(root)).cursor).toBe(0);

    // Another room is dealt with while that one waits — and the position stops
    // behind the held event rather than running on to the answered one.
    await streams[0]!.onEvent!(addressed(6, 'other'));
    expect((await SharedWatchAssignments.open(root)).sessions()).toHaveLength(1);
    expect((await SharedWatchAssignments.open(root)).cursor).toBe(4);

    // The sibling answers, and what was held goes to it — in the order it
    // arrived, and to the session that had the room all along.
    await (await SharedRoomInbox.open(taker)).serves(['room']);
    await streams[0]!.onEvent!(addressed(7, 'other'));
  } finally {
    abort.abort();
    await run;
  }

  expect(await readFile(join(taker, HANDOFF_FILE), 'utf8')).toBe(
    JSON.stringify({ sequence: 5, roomId: 'room', messageId: 'message-5' }) + '\n'
  );
  // One session for the other room, and the room that waited recorded against
  // the session that already had it rather than one started to take it over.
  const journal = await SharedWatchAssignments.open(root);
  expect(journal.sessions().map((entry) => entry.session.sessionId)).toContain(basename(taker));
  expect(journal.sessions()).toHaveLength(2);
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
  await answering(root, config, [['room'], []]);
  const taker = await answering(root, config, []);
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
    { sequence: 5, roomId: 'room', messageId: 'message-5' },
  ]);

  // The sibling claims the room while nothing is watching, and the controller
  // comes back to a stream that serves it nothing at all.
  await (await SharedRoomInbox.open(taker)).serves(['room']);
  const second = new AbortController();
  const resumed = runSharedWatcher(root, config, second.signal, supervision);
  try {
    await eventually(() => streams.length === 2);
  } finally {
    second.abort();
    await resumed;
  }

  expect(await readFile(join(taker, HANDOFF_FILE), 'utf8')).toBe(
    JSON.stringify({ sequence: 5, roomId: 'room', messageId: 'message-5' }) + '\n'
  );
  expect(warning.mock.calls.map((call) => String(call[0]))).toContainEqual(
    expect.stringContaining('when this controller last stopped')
  );
  const journal = await SharedWatchAssignments.open(root);
  expect(journal.pending()).toEqual([]);
  expect(journal.cursor).toBe(5);
});

it('takes a held event served again by a reopened stream as the one it already holds', async () => {
  // The stream reopens behind a held event, so the server offers it once more
  // while this controller is still holding its own copy. One message.
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-held-again-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  await answering(root, config, [['room'], []]);
  const taker = await answering(root, config, []);
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
    await (await SharedRoomInbox.open(taker)).serves(['room']);
    await streams[1]!.onEvent!(addressed(6, 'other'));
  } finally {
    second.abort();
    await resumed;
  }

  expect(await readFile(join(taker, HANDOFF_FILE), 'utf8')).toBe(
    JSON.stringify({ sequence: 5, roomId: 'room', messageId: 'message-5' }) + '\n'
  );
  expect((await SharedWatchAssignments.open(root)).pending()).toEqual([]);
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
  await assignments.park({ sequence: 4, roomId: 'room', messageId: 'held-first' });
  await assignments.park({ sequence: 900, roomId: 'room', messageId: 'held-second' });
  expect(assignments.cursor).toBe(0);

  await assignments.restart();
  const reloaded = await SharedWatchAssignments.open(root);
  expect(reloaded.cursor).toBe(0);
  expect(reloaded.pending()).toEqual([
    { sequence: 4, roomId: 'room', messageId: 'held-first' },
    { sequence: 900, roomId: 'room', messageId: 'held-second' },
  ]);

  const fresh = await decided(reloaded, config, {
    sequence: 4,
    roomId: 'other',
    messageId: 'collide',
  });
  await reloaded.handled(4);
  expect(reloaded.cursor).toBe(4);

  // Position 4 is that message's now. The held one is still recognised, and is
  // neither refused as a changed identity nor mistaken for a duplicate of it.
  const owner = await decided(reloaded, config, {
    sequence: 4,
    roomId: 'room',
    messageId: 'held-first',
  });
  expect(owner.session.sessionId).not.toBe(fresh.session.sessionId);
  await reloaded.released({ roomId: 'room', messageId: 'held-first' });
  expect(
    await decided(reloaded, config, { sequence: 900, roomId: 'room', messageId: 'held-second' })
  ).toEqual(owner);
  await reloaded.released({ roomId: 'room', messageId: 'held-second' });

  expect(reloaded.pending()).toEqual([]);
  // Nine hundred was a position under a numbering that is gone; the stream
  // reopens where this one actually reached.
  expect(reloaded.cursor).toBe(4);
  await decided(reloaded, config, { sequence: 5, roomId: 'other', messageId: 'next' });
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
});
