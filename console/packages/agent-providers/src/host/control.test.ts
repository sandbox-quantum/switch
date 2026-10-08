import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AttachmentTransfers, ControlError } from './attachment-transfers';
import {
  CONTROL_FILE,
  CONTROL_LINE_LIMIT_BYTES,
  ControlClient,
  ensureSessions,
  ensureThroughWatcher,
  serveControl,
} from './control';
import type { Supervision } from './launch';
import { SessionHostFailedError, SessionLinks } from './session-channel';
import { WatcherControl } from './watcher-tools';

const paths = vi.hoisted(() => ({ base: '' }));
const launched = vi.hoisted(() => ({ ensureSharedProcess: vi.fn() }));
vi.mock('./launch', () => ({
  ensureSharedProcess: launched.ensureSharedProcess,
  sharedSessionRoot: (id: string) => join(paths.base, id),
  liveSupervisor: async (root: string) =>
    (await readFile(join(root, 'running'), 'utf8').catch(() => null)) ? { build: 'b' } : null,
}));

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const event = (sequence: number) => ({
  contractVersion: 1,
  eventId: `event-${sequence}`,
  sessionId: 'session',
  sequence,
  occurredAt: '2026-09-24T12:00:00.000Z',
  body: { type: 'notice', level: 'info', code: 'X', message: 'hi' },
});

/** A session host child answering snapshots with its own name. */
function host() {
  const child = new EventEmitter() as EventEmitter & {
    connected: boolean;
    send: (message: unknown, callback: (error: Error | null) => void) => boolean;
  };
  child.connected = true;
  child.send = (message, callback) => {
    callback(null);
    const { id } = message as { id: number };
    setImmediate(() => child.emit('message', { kind: 'reply', id, ok: true, value: 'snapshot' }));
    return true;
  };
  return child;
}

async function started() {
  const base = await mkdtemp(join(tmpdir(), 'control-'));
  roots.push(base);
  paths.base = base;
  const links = new SessionLinks();
  const ensure = vi.fn(async () => ({ created: true }));
  const stop = new AbortController();
  const watcher = new WatcherControl();
  const transfers = new AttachmentTransfers(base);
  const serving = serveControl(
    base,
    { agentId: 'agent', links, ensure, watcher, transfers },
    stop.signal
  );
  await vi.waitFor(async () =>
    expect(await readFile(join(base, CONTROL_FILE), 'utf8')).toBeTruthy()
  );
  const control = JSON.parse(await readFile(join(base, CONTROL_FILE), 'utf8')) as {
    port: number;
    token: string;
  };
  const client = (token = control.token) => {
    const socket = connect(control.port, '127.0.0.1');
    return new ControlClient(socket, token);
  };
  return { base, links, ensure, stop, serving, client, watcher, control };
}

it('relays requests to a session host and its events back', async () => {
  const { base, links, ensure, stop, serving, client } = await started();
  const sessionRoot = join(base, 'session');
  await mkdir(sessionRoot, { recursive: true });
  await writeFile(join(sessionRoot, 'running'), 'yes');
  const child = host();
  links.attach(sessionRoot, child as unknown as ChildProcess);
  child.emit('message', { kind: 'ready' });

  const console = client();
  await console.ready;
  expect(await console.request('session', { type: 'snapshot' })).toBe('snapshot');

  const heard: number[] = [];
  const unsubscribe = await console.subscribe(
    'session',
    (pushed) => heard.push(pushed.sequence),
    () => {}
  );
  child.emit('message', { kind: 'event', event: event(1) });
  await vi.waitFor(() => expect(heard).toEqual([1]));
  unsubscribe();

  expect(
    await console.ensure({ config: {}, resuming: false, restart: false, startSource: 'room' })
  ).toEqual({
    created: true,
  });
  expect(ensure).toHaveBeenCalledWith({
    config: {},
    resuming: false,
    restart: false,
    startSource: 'room',
  });

  console.close();
  stop.abort();
  await serving;
  await expect(readFile(join(base, CONTROL_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('passes on why a session host failed, to a waiting request and to subscribers', async () => {
  const { base, links, stop, serving, client } = await started();
  const sessionRoot = join(base, 'session');
  await mkdir(join(sessionRoot, 'supervisor'), { recursive: true });
  await writeFile(join(sessionRoot, 'running'), 'yes');
  const child = host();
  links.attach(sessionRoot, child as unknown as ChildProcess);

  const console = client();
  await console.ready;
  const failures: (string | null)[] = [];
  const unsubscribe = await console.subscribe(
    'session',
    () => {},
    (failure) => failures.push(failure)
  );
  expect(failures).toEqual([null]);
  const request = console.request('session', { type: 'snapshot' });
  const refused = expect(request).rejects.toBeInstanceOf(SessionHostFailedError);
  await writeFile(
    join(sessionRoot, 'supervisor', 'failure.json'),
    JSON.stringify({ message: 'Sign in on the execution machine with claude auth login.' })
  );
  child.emit('exit', 1, null);
  await refused;
  await vi.waitFor(() =>
    expect(failures).toEqual([null, 'Sign in on the execution machine with claude auth login.'])
  );
  unsubscribe();

  // A subscriber arriving after the failure hears it too.
  const late: (string | null)[] = [];
  const unsubscribeLate = await console.subscribe(
    'session',
    () => {},
    (failure) => late.push(failure)
  );
  expect(late).toEqual(['Sign in on the execution machine with claude auth login.']);
  // And hears it cleared once a host comes up again.
  const next = host();
  links.attach(sessionRoot, next as unknown as ChildProcess);
  next.emit('message', { kind: 'ready' });
  await vi.waitFor(() =>
    expect(late).toEqual(['Sign in on the execution machine with claude auth login.', null])
  );
  unsubscribeLate();

  console.close();
  stop.abort();
  await serving;
});

it('answers at once for a session nothing is running', async () => {
  const { stop, serving, client } = await started();
  const console = client();
  await console.ready;
  await expect(console.request('stopped', { type: 'snapshot' })).rejects.toThrow('not running');
  console.close();
  stop.abort();
  await serving;
});

it('refuses a client without the secret', async () => {
  const { stop, serving, client } = await started();
  await expect(client('wrong').ready).rejects.toThrow();
  stop.abort();
  await serving;
});

it('moves a room to a session through the watcher, and says why when it cannot', async () => {
  const { stop, serving, client, watcher } = await started();
  const console = client();
  await console.ready;
  await expect(console.place('session', 'room')).rejects.toThrow('room watcher is not running');
  const placed = vi.fn(async (sessionId: string, roomId: string) => ({
    sessionId,
    roomId,
    previous: null,
    displaced: 'other',
  }));
  const forgot = vi.fn(async () => {});
  const unbind = watcher.bind({
    place: placed,
    forget: forgot,
    ensure: async () => ({ created: false }),
  });
  await console.forget('gone');
  expect(forgot).toHaveBeenCalledWith('gone');
  expect(await console.place('session', 'room')).toEqual({
    sessionId: 'session',
    roomId: 'room',
    previous: null,
    displaced: 'other',
  });
  expect(placed).toHaveBeenCalledWith('session', 'room');
  placed.mockRejectedValueOnce(new Error('Switch refused to move room room'));
  await expect(console.place('session', 'room')).rejects.toThrow('Switch refused');
  unbind();
  console.close();
  stop.abort();
  await serving;
});

it('stops serving while Console still holds its connection open', async () => {
  const { base, stop, serving, client } = await started();
  const console = client();
  await console.ready;
  stop.abort();
  await serving;
  await expect(readFile(join(base, CONTROL_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(console.request('session', { type: 'snapshot' })).rejects.toThrow();
});

it('answers the watcher health and pushes every change to a client watching it', async () => {
  const { stop, serving, client, watcher } = await started();
  const console = client();
  await console.ready;
  expect(await console.health()).toMatchObject({
    state: 'not-running',
    detail: null,
    placements: {},
  });

  const heard: unknown[] = [];
  const stopWatching = await console.onHealth((health) => heard.push(health));
  watcher.report({ state: 'connecting', placements: { session: 'room' } });
  watcher.report({ state: 'connected' });
  // Nothing changed: nothing pushed.
  watcher.report({ state: 'connected', placements: { session: 'room' } });
  watcher.report({ state: 'disconnected', detail: 'HTTP 502: bad gateway' });
  await vi.waitFor(() => expect(heard).toHaveLength(3));
  expect(heard).toMatchObject([
    { state: 'connecting', detail: null, placements: { session: 'room' } },
    { state: 'connected', detail: null, placements: { session: 'room' } },
    { state: 'disconnected', detail: 'HTTP 502: bad gateway', placements: { session: 'room' } },
  ]);
  expect(await console.health()).toEqual(watcher.health());

  stopWatching();
  // The sidecar hears the unwatch before the next report.
  await console.health();
  watcher.report({ state: 'connected', detail: null });
  await console.health();
  expect(heard).toHaveLength(3);

  const closed = vi.fn();
  console.onClose(closed);
  console.close();
  await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  stop.abort();
  await serving;
});

it('still starts a session for a Console that sends no start source', async () => {
  // What a Console older than start sources writes: the same message, one key short.
  const { ensure, stop, serving, control } = await started();
  const socket = connect(control.port, '127.0.0.1');
  const replies: unknown[] = [];
  let buffered = '';
  socket.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    let end: number;
    while ((end = buffered.indexOf('\n')) >= 0) {
      replies.push(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
    }
  });
  socket.write(`${JSON.stringify({ token: control.token })}\n`);
  socket.write(
    `${JSON.stringify({ id: 1, ensure: { config: {}, resuming: false, restart: false } })}\n`
  );

  await vi.waitFor(() =>
    expect(replies).toContainEqual({ id: 1, ok: true, value: { created: true } })
  );
  expect(ensure).toHaveBeenCalledWith({ config: {}, resuming: false, restart: false });

  socket.destroy();
  stop.abort();
  await serving;
});

const sessionConfig = {
  session: {
    sessionId: 'session-1',
    agentId: 'agent',
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
      sessionId: 'session-1',
      cwd: '/work',
      runtimeMode: 'approval-required',
      env: {},
      mcpServers: {},
    },
  },
};

it('starts the session a sidecar is asked for with the start source it was given', async () => {
  paths.base = '/sessions';
  launched.ensureSharedProcess.mockReset().mockResolvedValue({ created: true });
  const supervision = { build: 'b' } as unknown as Supervision;

  await ensureSessions(supervision)({
    config: sessionConfig,
    resuming: false,
    restart: false,
    startSource: 'room',
  });

  expect(launched.ensureSharedProcess).toHaveBeenCalledWith(
    expect.objectContaining({
      root: join('/sessions', 'session-1'),
      watcher: false,
      supervision,
      startSource: 'room',
    })
  );
});

it('records a start source an older Console did not send as not known', async () => {
  launched.ensureSharedProcess.mockReset().mockResolvedValue({ created: true });

  await ensureSessions({ build: 'b' } as unknown as Supervision)({
    config: sessionConfig,
    resuming: false,
    restart: false,
  });

  expect(launched.ensureSharedProcess.mock.calls[0]![0]).toMatchObject({ startSource: null });
});

it('carries a start source Console could not name as null, which a resume always does', async () => {
  const { ensure, stop, serving, client } = await started();
  const console = client();
  await console.ready;

  await console.ensure({ config: {}, resuming: true, restart: false, startSource: null });

  expect(ensure).toHaveBeenCalledWith({
    config: {},
    resuming: true,
    restart: false,
    startSource: null,
  });
  console.close();
  stop.abort();
  await serving;
});

it('starts a session whose start source is newer than this sidecar, as not known', async () => {
  const { ensure, stop, serving, control } = await started();
  const socket = connect(control.port, '127.0.0.1');
  const replies: unknown[] = [];
  let buffered = '';
  socket.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    let end: number;
    while ((end = buffered.indexOf('\n')) >= 0) {
      replies.push(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
    }
  });
  socket.write(`${JSON.stringify({ token: control.token })}\n`);
  socket.write(
    `${JSON.stringify({
      id: 1,
      ensure: { config: {}, resuming: false, restart: false, startSource: 'scheduled' },
    })}\n`
  );

  await vi.waitFor(() =>
    expect(replies).toContainEqual({ id: 1, ok: true, value: { created: true } })
  );
  expect(ensure).toHaveBeenCalledWith({
    config: {},
    resuming: false,
    restart: false,
    startSource: null,
  });

  socket.destroy();
  stop.abort();
  await serving;
});

it('starts a session for an agents controller by its id alone, through the watcher', async () => {
  const watcher = new WatcherControl();
  const ensured = vi.fn(async () => ({ created: true }));
  watcher.bind({ place: vi.fn(), forget: vi.fn(), ensure: ensured });
  const ensure = ensureThroughWatcher(watcher);
  expect(
    await ensure({
      config: { session: { sessionId: 's1' } },
      resuming: false,
      restart: false,
      startSource: 'user',
    })
  ).toEqual({ created: true });
  expect(ensured).toHaveBeenCalledWith({
    sessionId: 's1',
    resuming: false,
    restart: false,
    startSource: 'user',
  });
  await expect(
    ensure({
      config: { session: { sessionId: 's2' }, start: { provider: 'claude' } },
      resuming: false,
      restart: false,
    })
  ).rejects.toThrow('by its id alone');
  expect(ensured).toHaveBeenCalledTimes(1);
});

it('hands a refusal’s code to the client, which raises it as the same error', async () => {
  const { stop, serving, client } = await started();
  const console = client();
  await console.ready;
  const refused = await console.send({ page: { snapshotId: 'snapshot', index: 0 } }).then(
    () => null,
    (error: unknown) => error
  );
  expect(refused).toBeInstanceOf(ControlError);
  expect(refused).toMatchObject({
    code: 'refused_message',
    message: 'Pages are served only to relayed answers.',
  });
  console.close();
  stop.abort();
  await serving;
});

it('drops a connection that sends a line longer than its limit', async () => {
  const stream = new PassThrough();
  const console = new ControlClient(stream, 'token');
  const closed = new Promise<Error>((resolve) => console.onClose(resolve));
  stream.push('x'.repeat(CONTROL_LINE_LIMIT_BYTES / 2));
  stream.push('x'.repeat(CONTROL_LINE_LIMIT_BYTES / 2 + 1));
  expect((await closed).message).toMatch(/longer than/);
  await expect(console.ready).rejects.toThrow(/longer than/);
});

it('answers a reasoning ask from the session host, and from no host with none', async () => {
  const { base, links, stop, serving, client, watcher } = await started();
  const sessionRoot = join(base, 'session');
  const list = { epoch: 'epoch', turns: [] };
  const child = host();
  const asked: unknown[] = [];
  child.send = (message, callback) => {
    callback(null);
    const { id, request } = message as { id: number; request: unknown };
    asked.push(request);
    setImmediate(() => child.emit('message', { kind: 'reply', id, ok: true, value: list }));
    return true;
  };
  links.attach(sessionRoot, child as unknown as ChildProcess);
  child.emit('message', { kind: 'ready' });

  const console = client();
  await console.ready;
  expect(await console.reasoning('session', ['turn'])).toEqual(list);
  expect(asked).toEqual([{ type: 'reasoning', turnIds: ['turn'] }]);
  expect(await console.reasoning('elsewhere', null)).toBeNull();
  expect(await console.request('session', { type: 'reasoning', turnIds: null })).toEqual(list);
  // A plain health ask is still a health ask.
  expect(await console.health()).toEqual(watcher.health());

  console.close();
  stop.abort();
  await serving;
});

it('reads as a health ask to a sidecar that predates reasoning, so its connection stays up', async () => {
  const stream = new PassThrough();
  const toSidecar: string[] = [];
  const duplex = Object.assign(stream, {
    write: (line: string) => {
      toSidecar.push(line);
      const message = JSON.parse(line) as Record<string, unknown>;
      // What an older sidecar parses the line as: its plain health message.
      const old = z.object({ id: z.number().int(), health: z.literal(true) }).safeParse(message);
      if ('token' in message) setImmediate(() => stream.emit('data', '{"authenticated":true}\n'));
      else if (old.success)
        setImmediate(() =>
          stream.emit(
            'data',
            `${JSON.stringify({ id: old.data.id, ok: true, value: { state: 'connected' } })}\n`
          )
        );
      return true;
    },
  });
  const console = new ControlClient(duplex, 'token');
  await console.ready;
  expect(await console.reasoning('session', null)).toEqual({ state: 'connected' });
  expect(console.isClosed).toBe(false);
  expect(toSidecar).toHaveLength(2);
});
