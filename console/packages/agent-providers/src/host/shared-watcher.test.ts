import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as runtime from '@sandboxaq/switch-agent-runtime';
import type { AgentBridgeEvent, SwitchEventStreamDeps } from '@sandboxaq/switch-agent-runtime';
import { afterEach, expect, it, vi } from 'vitest';
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
    ).rejects.toThrow('incomplete record');
    expect(restarted.cursor).toBe(10);
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

it('resumes at the server head after its numbering restarts, keeping room sessions', async () => {
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

it('leaves the rest of a restore unstarted once spawning is turned off midway', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-watch-restore-'));
  roots.push(root);
  paths.root = root;
  const config = await spawning(root);
  const assignments = await SharedWatchAssignments.open(root);
  const first = await assignments.assign(config, {
    sequence: 1,
    roomId: 'room',
    messageId: 'first',
  });
  await assignments.assign(config, { sequence: 2, roomId: 'other', messageId: 'second' });
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
