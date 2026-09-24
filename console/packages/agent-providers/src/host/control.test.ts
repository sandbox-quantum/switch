import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CONTROL_FILE, ControlClient, serveControl } from './control';
import { SessionLinks } from './session-channel';
import { WatcherControl } from './watcher-tools';

const paths = vi.hoisted(() => ({ base: '' }));
vi.mock('./launch', () => ({
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
    send: (message: unknown, callback: (error: Error | null) => void) => boolean;
  };
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
  const serving = serveControl(base, links, ensure, watcher, stop.signal);
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
  return { base, links, ensure, stop, serving, client, watcher };
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
  const unsubscribe = await console.subscribe('session', (pushed) => heard.push(pushed.sequence));
  child.emit('message', { kind: 'event', event: event(1) });
  await vi.waitFor(() => expect(heard).toEqual([1]));
  unsubscribe();

  expect(await console.ensure({ config: {}, resuming: false, restart: false })).toEqual({
    created: true,
  });
  expect(ensure).toHaveBeenCalledWith({ config: {}, resuming: false, restart: false });

  console.close();
  stop.abort();
  await serving;
  await expect(readFile(join(base, CONTROL_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
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
  const unbind = watcher.bind(placed);
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
