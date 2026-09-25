import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildSharedHostConfig } from './build-shared-config';
import { readCutoverManifest, readStateVersion } from './cutover-manifest';
import { legacySessionsBase, PreflightBlockedError, runHostedPreflight } from './hosted-preflight';
import type { SharedHostConfig } from './shared-config';

const AGENT = 'agent-placeholder';
const WATCHER = 'watcher-placeholder';
const SESSION = 'session-placeholder';
const ROOM = '!room:example.test';
const JOIN = `room_join:${'0'.repeat(64)}`;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hosted-preflight-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function config(sessionId: string, env: Record<string, string>, ids: string): SharedHostConfig {
  return buildSharedHostConfig({
    session: { sessionId, agentId: AGENT, provider: 'opencode' },
    launch: { cwd: '/workspace', runtimeMode: 'full-access', env, model: undefined },
    capabilities: { approvals: true, userInput: true },
    execution: {
      credentialsPath: '/state/switch-credentials.json',
      inheritEnv: ['PATH'],
      binaryPath: '/usr/local/bin/opencode',
      codexConfig: '',
      skill: '',
      context: '',
      agentDefinition: undefined,
    },
    ids: { hostId: `host-${ids}`, epoch: `epoch-${ids}`, connectionId: `connection-${ids}` },
  });
}

/** A config as the session-table worker wrote it: its own rooms and cursor, and the runtime it baked in. */
function legacyConfig(sessionId: string, rooms: string[]): Record<string, unknown> {
  const value = config(sessionId, { XDG_DATA_HOME: join(root, 'xdg', 'data') }, 'legacy');
  return {
    ...value,
    roomConnection: { connectionId: 'connection-legacy', rooms, startCursor: 3 },
    execution: {
      ...value.execution,
      mcpRuntime: '@sandboxaq/switch-agent-runtime@0.0.0',
      mcpRuntimePath: '/opt/runtime/index.js',
    },
  };
}

function candidate() {
  return {
    version: 1 as const,
    spec: { revision: 1, watch: true, session: { sessionId: WATCHER, agentId: AGENT } },
    config: config(WATCHER, { XDG_DATA_HOME: join(root, 'provider-data') }, 'new'),
  };
}

const sessionRoot = (sessionId: string) =>
  join(legacySessionsBase(root), createHash('sha256').update(sessionId).digest('hex'));

async function put(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
}

const journal = (records: unknown[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join('');

function command(commandId: string, origin: Record<string, unknown>) {
  return {
    type: 'accepted',
    command: {
      contractVersion: 1,
      commandId,
      sessionId: SESSION,
      epoch: 'epoch-legacy',
      origin: { actorId: '@owner:example.test', ...origin },
      body: { type: 'message.send', text: 'hi', attachments: [], delivery: 'queue' },
    },
  };
}

function event(sequence: number, body: unknown) {
  return {
    contractVersion: 1,
    eventId: `event-${sequence}`,
    sessionId: SESSION,
    occurredAt: '2026-01-01T00:00:00Z',
    sequence,
    body,
  };
}

/** A volume as #538's worker left it: one room connection per session, owners stamped with a machine. */
async function legacyVolume(): Promise<void> {
  await put(join(root, 'hosted-deployment.json'), {
    version: 1,
    spec: {
      watch: true,
      mcpRuntime: '@sandboxaq/switch-agent-runtime@0.0.0',
      session: { sessionId: WATCHER, agentId: AGENT },
    },
    config: legacyConfig(WATCHER, []),
  });
  await put(join(root, 'config.json'), legacyConfig(WATCHER, []));
  await put(join(root, 'watch.json'), { enabled: true });
  await put(join(root, 'shared-owner.lock'), { machine: 'machine-placeholder', pid: 1 });
  await put(
    join(root, 'assignments.jsonl'),
    journal([{ sequence: 1, roomId: ROOM, messageId: '$m0', config: legacyConfig(SESSION, []) }])
  );
  const session = sessionRoot(SESSION);
  await put(join(session, 'config.json'), legacyConfig(SESSION, [ROOM]));
  await put(join(session, 'supervisor', 'owner.json'), { machine: 'machine-placeholder' });
  await put(
    join(session, 'inbox.jsonl'),
    journal([
      command('command-room', {
        surface: 'slack',
        roomId: ROOM,
        threadId: '$thread',
        messageId: '$m1',
      }),
      { type: 'dispatched', commandId: 'command-room' },
      command('command-console', {
        surface: 'console',
        roomId: null,
        threadId: null,
        messageId: null,
      }),
      { type: 'reset-started' },
    ])
  );
  await put(
    join(session, 'events.jsonl'),
    journal([
      event(1, {
        type: 'turn.upsert',
        turnId: 'turn-1',
        status: 'running',
        commandId: 'command-room',
      }),
      event(2, {
        type: 'request.opened',
        request: {
          requestId: 'request-1',
          turnId: 'turn-1',
          revision: 0,
          state: 'open',
          content: {
            kind: 'approval',
            title: 'Run?',
            detail: null,
            options: [{ optionId: 'yes', label: 'Yes', decision: 'accept' }],
          },
          expiresAt: null,
        },
      }),
    ])
  );
  await put(
    join(session, 'room-inbox.jsonl'),
    journal([
      { type: 'rooms', rooms: [ROOM] },
      { type: 'received', sequence: 1, roomId: ROOM, messageId: '$m1' },
      { type: 'received', sequence: 2, roomId: ROOM, messageId: '$m2', missed: 0, gap: null },
      { type: 'failure-notified', identity: JSON.stringify([ROOM, '$m2']), reason: 'startup' },
      { type: 'received', sequence: 3, roomId: ROOM, messageId: JOIN },
      { type: 'ack', sequence: 1 },
    ])
  );
  await put(join(session, 'provider-data', 'opencode', 'storage', 'session.json'), 'history');
  await put(join(session, 'provider-data', 'opencode', 'auth.json'), 'credential-placeholder');
}

async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files[relative(root, path)] = await readFile(path, 'utf8');
    }
  };
  await walk(root);
  return files;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

it('moves a #538 volume to the watcher layout and lists what it held', async () => {
  await legacyVolume();
  expect(await runHostedPreflight(root, candidate())).toBe(true);

  const plan = await readJson(join(root, 'hosted-deployment.json'));
  expect(plan.spec).toEqual(candidate().spec);
  expect(plan.config.session).toMatchObject({ hostId: 'host-legacy', epoch: 'epoch-legacy' });
  expect(plan.config.roomConnection).toEqual({ connectionId: 'connection-legacy' });
  expect(plan.config.start.input.env.XDG_DATA_HOME).toBe(join(root, 'provider-data'));
  expect(await readJson(join(root, 'config.json'))).toEqual(plan.config);
  expect(await exists(join(root, 'hosted-deployment.json.pre-cutover'))).toBe(true);

  const session = sessionRoot(SESSION);
  const migrated = await readJson(join(session, 'config.json'));
  expect(migrated.roomConnection).toEqual({
    connectionId: 'connection-legacy',
    restoreRoomId: ROOM,
  });
  expect(migrated.execution.mcpRuntimePath).toBeUndefined();
  expect(migrated.start.input.env.XDG_DATA_HOME).toBe(join(root, 'provider-data'));
  const [assignment] = (await readFile(join(root, 'assignments.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  expect(assignment.config.roomConnection).toEqual({ connectionId: 'connection-legacy' });
  expect(await readJson(join(root, 'placements.json'))).toEqual({
    placements: { [SESSION]: ROOM },
  });

  expect(await exists(join(session, 'room-inbox.jsonl'))).toBe(false);
  expect(await exists(join(session, 'room-inbox.jsonl.pre-cutover'))).toBe(true);
  expect(await exists(join(root, 'shared-owner.lock'))).toBe(false);
  expect(await exists(join(session, 'supervisor', 'owner.json'))).toBe(false);
  expect(
    await readFile(join(root, 'provider-data', 'opencode', 'storage', 'session.json'), 'utf8')
  ).toBe('history');
  expect(await exists(join(root, 'provider-data', 'opencode', 'auth.json'))).toBe(false);
  expect(await exists(join(session, 'provider-data'))).toBe(false);

  const manifest = await readCutoverManifest(root);
  expect(manifest?.manifest_sha256).toBe(
    createHash('sha256').update(JSON.stringify(manifest?.items)).digest('hex')
  );
  expect(manifest?.items).toHaveLength(5);
  expect(manifest?.items).toEqual(
    expect.arrayContaining([
      {
        kind: 'room_message',
        session_id: SESSION,
        room_id: ROOM,
        message_id: '$m1',
        thread_id: '$thread',
        room_pending: false,
        failure_notified: false,
        host: 'dispatched',
      },
      {
        kind: 'room_message',
        session_id: SESSION,
        room_id: ROOM,
        message_id: '$m2',
        thread_id: null,
        room_pending: true,
        failure_notified: true,
        host: null,
      },
      {
        kind: 'console_command',
        session_id: SESSION,
        command_id: 'command-console',
        host: 'accepted',
      },
      {
        kind: 'request_open',
        session_id: SESSION,
        request_id: 'request-1',
        room_id: ROOM,
        thread_id: '$thread',
      },
      { kind: 'reset_pending', session_id: SESSION },
    ])
  );
  expect(await readStateVersion(root)).toBe(1);
});

it('changes nothing on a second run', async () => {
  await legacyVolume();
  await runHostedPreflight(root, candidate());
  const before = await snapshot();
  expect(await runHostedPreflight(root, candidate())).toBe(false);
  expect(await snapshot()).toEqual(before);
});

it('finishes a preflight that stopped part way with the manifest it first listed', async () => {
  await legacyVolume();
  await runHostedPreflight(root, candidate());
  const before = await snapshot();
  await unlink(join(root, 'state-version.json'));
  expect(await runHostedPreflight(root, candidate())).toBe(true);
  expect(await snapshot()).toEqual(before);
});

it('stops at a journal it cannot read, names it, and finishes once it is repaired', async () => {
  await legacyVolume();
  const events = join(sessionRoot(SESSION), 'events.jsonl');
  const good = await readFile(events, 'utf8');
  await writeFile(events, `${good}{"contractVersion":1}\n`);
  const blocked = runHostedPreflight(root, candidate());
  await expect(blocked).rejects.toBeInstanceOf(PreflightBlockedError);
  await expect(blocked).rejects.toThrow(`${events}:3`);
  expect(await readJson(join(root, 'preflight-blocked.json'))).toMatchObject({
    version: 1,
    step: 'sessions',
    file: events,
    line: 3,
  });
  expect(await readStateVersion(root)).toBeNull();

  await writeFile(events, good);
  expect(await runHostedPreflight(root, candidate())).toBe(true);
  expect(await exists(join(root, 'preflight-blocked.json'))).toBe(false);
  expect((await readCutoverManifest(root))?.items).toHaveLength(5);
});

it('refuses to choose between two copies of a provider file', async () => {
  await legacyVolume();
  await put(join(root, 'provider-data', 'opencode', 'storage', 'session.json'), 'other history');
  await expect(runHostedPreflight(root, candidate())).rejects.toThrow('different content');
  expect(await readJson(join(root, 'preflight-blocked.json'))).toMatchObject({
    step: 'provider-homes',
  });
});

it('refuses a single room session, which has no watcher layout', async () => {
  await legacyVolume();
  const plan = await readJson(join(root, 'hosted-deployment.json'));
  delete plan.spec.watch;
  plan.spec.room = { roomId: ROOM, startCursor: 0 };
  await put(join(root, 'hosted-deployment.json'), plan);
  await expect(runHostedPreflight(root, candidate())).rejects.toThrow('single room session');
  expect(await readJson(join(root, 'preflight-blocked.json'))).toMatchObject({ step: 'plan' });
});

it('only stamps the layout version on a volume with nothing to migrate', async () => {
  expect(await runHostedPreflight(root, candidate())).toBe(false);
  expect(Object.keys(await snapshot())).toEqual(['state-version.json']);
  expect(await readCutoverManifest(root)).toBeNull();
});

it('refuses a volume from a newer worker', async () => {
  await put(join(root, 'state-version.json'), { version: 2 });
  await expect(runHostedPreflight(root, candidate())).rejects.toThrow('newer');
});
