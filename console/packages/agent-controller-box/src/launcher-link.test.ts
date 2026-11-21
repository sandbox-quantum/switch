import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LauncherLink, type LinkState, LOST_AFTER_MS, QUIET_AFTER_MS } from './launcher-link';
import { encodeLine, type LauncherOrder } from './launcher-protocol';

const AGENT = '0fa651dd-faa3-4dda-80b8-f784b1750c95';
const BOOT1 = '1'.repeat(32);
const BOOT2 = '2'.repeat(32);

let dir: string;
let clock: number;
let link: LauncherLink;
let states: LinkState[];
let logged: [string, Record<string, string | number>][];
let measured: number;
let restarted: string[];
let exited: [string, number][];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'launcher-link-'));
  clock = 0;
  states = [];
  logged = [];
  measured = 0;
  restarted = [];
  exited = [];
  link = new LauncherLink({
    socketPath: join(dir, 'launcher.sock'),
    now: () => clock,
    log: (event, fields) => void logged.push([event, fields]),
    onState: (state) => void states.push(state),
    onRestarted: (bootId) => void restarted.push(bootId),
    onMeasure: () => void measured++,
    onExited: (agentId, launchId) => void exited.push([agentId, launchId]),
  });
  await link.listen();
});
afterEach(async () => {
  await link.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A launcher: connects, can send lines, and records the orders it gets. */
async function launcher() {
  const socket: Socket = connect(join(dir, 'launcher.sock'));
  const orders: LauncherOrder[] = [];
  let buffered = '';
  socket.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    const parts = buffered.split('\n');
    buffered = parts.pop()!;
    for (const part of parts) if (part) orders.push(JSON.parse(part) as LauncherOrder);
  });
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
  return { socket, orders, closed, send: (line: string) => socket.write(line) };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const hello = (bootId = BOOT1) => encodeLine({ kind: 'hello', version: '1', bundle: 'b', bootId });
const measure = () => encodeLine({ kind: 'measure', at: 1, agents: {} });

describe('LauncherLink', () => {
  it('listens on a socket the agents’ group can connect to (0660)', () => {
    expect(statSync(join(dir, 'launcher.sock')).mode & 0o777).toBe(0o660);
    // The umask was set only around the listen, and is back as it was.
    const now = process.umask(0o022);
    process.umask(now);
    expect(now).not.toBe(0o117);
  });

  it('is quiet after hello, live once it measures, then quiet at 6 s and lost at 30 s of silence', async () => {
    const l = await launcher();
    l.send(hello());
    await tick();
    expect(link.current).toBe('quiet');
    l.send(measure());
    await tick();
    expect(link.current).toBe('live');
    expect(measured).toBe(1);
    clock += QUIET_AFTER_MS;
    link.tick();
    expect(link.current).toBe('quiet');
    clock += LOST_AFTER_MS;
    link.tick();
    expect(link.current).toBe('lost');
    await l.closed; // a silent launcher's socket is closed
    expect(logged).toContainEqual(['launcher_lost', { reason: 'silent' }]);
  });

  it('first wins: a second connection is refused, never a replacement', async () => {
    const first = await launcher();
    first.send(hello());
    await tick();
    const second = await launcher();
    await second.closed;
    expect(logged).toContainEqual(['launcher_refused', { reason: 'already_connected' }]);
    first.send(measure());
    await tick();
    expect(link.current).toBe('live');
  });

  it('refuses a connection whose first line is not hello', async () => {
    const l = await launcher();
    l.send(measure());
    await l.closed;
    expect(logged).toContainEqual(['launcher_refused', { reason: 'no_hello' }]);
  });

  it('matches replies to orders, and fails orders at once when the launcher is lost', async () => {
    const l = await launcher();
    l.send(hello());
    await tick();
    const answer = link.order({ kind: 'observe', agentId: AGENT });
    await tick();
    expect(l.orders).toEqual([{ kind: 'observe', id: 1, agentId: AGENT }]);
    l.send(encodeLine({ kind: 'reply', id: 1, ok: true, observation: { alive: true } }));
    expect(await answer).toMatchObject({ ok: true, observation: { alive: true } });
    const unanswered = link.order({ kind: 'stop', agentId: AGENT, wait: true, asked: true });
    l.socket.destroy();
    expect(await unanswered).toMatchObject({ ok: false, code: 'launcher_lost' });
    expect(await link.order({ kind: 'observe', agentId: AGENT })).toMatchObject({
      ok: false,
      code: 'launcher_lost',
    });
  });

  it('logs the first launcher as connected and any later one as a reconnect, with a count', async () => {
    const first = await launcher();
    first.send(hello(BOOT1));
    await tick();
    first.socket.destroy();
    await tick();
    const second = await launcher();
    second.send(hello(BOOT2));
    await tick();
    const greetings = logged.filter(([event]) => event.startsWith('launcher_'));
    expect(greetings.filter(([event]) => event === 'launcher_connected')).toEqual([
      ['launcher_connected', { version: '1', connections: 1 }],
    ]);
    expect(greetings.filter(([event]) => event === 'launcher_reconnected')).toEqual([
      ['launcher_reconnected', { version: '1', connections: 2 }],
    ]);
    second.socket.destroy();
  });

  it('tells a restarted agents container by its new boot id, and passes exits on', async () => {
    const first = await launcher();
    first.send(hello(BOOT1));
    await tick();
    first.send(encodeLine({ kind: 'exited', agentId: AGENT, launchId: 4 }));
    await tick();
    first.socket.destroy();
    await tick();
    expect(link.current).toBe('lost');
    const second = await launcher();
    second.send(hello(BOOT2));
    await tick();
    expect(restarted).toEqual([BOOT2]);
    expect(exited).toEqual([[AGENT, 4]]);
  });

  it('takes handlers set after it was made, for an owner made later', async () => {
    const late: number[] = [];
    link.listenTo({ onMeasure: (m) => void late.push(m.at) });
    const l = await launcher();
    l.send(hello() + measure());
    await tick();
    expect(late).toEqual([1]);
    // Replaced, not added to; the others are kept.
    expect(measured).toBe(0);
    expect(states).toContain('live');
  });

  it('ignores and counts a reply to nothing asked', async () => {
    const l = await launcher();
    l.send(hello() + measure());
    l.send(encodeLine({ kind: 'reply', id: 999, ok: true }));
    await tick();
    expect(link.unmatchedReplies).toBe(1);
    expect(logged).toContainEqual([
      'launcher_line_refused',
      { reason: 'unmatched_reply', count: 1 },
    ]);
  });

  it('refuses an exit for an agent the controller did not launch (C6), and counts it', async () => {
    link.listenTo({ launched: (agentId) => agentId === AGENT });
    const l = await launcher();
    l.send(hello());
    l.send(
      encodeLine({ kind: 'exited', agentId: '148578ff-daef-412f-9ade-2f5ec48420db', launchId: 1 })
    );
    l.send(encodeLine({ kind: 'exited', agentId: AGENT, launchId: 2 }));
    await tick();
    expect(exited).toEqual([[AGENT, 2]]);
    expect(link.unknownExits).toBe(1);
    expect(logged).toContainEqual(['launcher_line_refused', { reason: 'unknown_agent', count: 1 }]);
  });

  it('on loopback, listens on 127.0.0.1 and the one port given, and fails rather than take another', async () => {
    const port = await freeLoopbackPort();
    const onLoopback = new LauncherLink({
      address: { kind: 'loopback', port },
      now: () => clock,
      log: (event, fields) => void logged.push([event, fields]),
    });
    await onLoopback.listen();
    const socket = connect({ host: '127.0.0.1', port });
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    socket.write(hello());
    await tick();
    expect(onLoopback.current).toBe('quiet');
    // The port is taken now: a second listener on it fails, and never moves to another port.
    const squatter = new LauncherLink({
      address: { kind: 'loopback', port },
      now: () => clock,
      log: () => {},
    });
    await expect(squatter.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    socket.destroy();
    await onLoopback.close();
  });
});

async function freeLoopbackPort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('LauncherLink: file requests (the file explorer)', () => {
  type Got = {
    kind: string;
    id: number;
    ok?: boolean;
    code?: string;
    seq?: number;
    last?: boolean;
  };

  it('routes every reply and chunk under a file request’s id to it, in order, until it ends', async () => {
    const l = await launcher();
    l.send(hello());
    l.send(measure());
    await tick();
    const got: Got[] = [];
    const id = link.startFile(
      { kind: 'files_zip', path: 'w', includeCaches: false },
      (r) => void got.push(r)
    );
    await tick();
    expect(l.orders.at(-1)).toEqual({ kind: 'files_zip', path: 'w', includeCaches: false, id });
    l.send(encodeLine({ kind: 'files_chunk', id, seq: 0, data: 'AA==', last: false }));
    await tick();
    link.followFile('files_more', id);
    await tick();
    expect(l.orders.at(-1)).toEqual({ kind: 'files_more', id });
    l.send(encodeLine({ kind: 'files_chunk', id, seq: 1, data: '', last: true }));
    await tick();
    expect(got.map((g) => [g.kind, g.seq, g.last])).toEqual([
      ['files_chunk', 0, false],
      ['files_chunk', 1, true],
    ]);
    link.endFile(id);
    l.send(encodeLine({ kind: 'files_chunk', id, seq: 2, data: '', last: true }));
    await tick();
    expect(got).toHaveLength(2);
    expect(link.unmatchedReplies).toBe(1);
  });

  it('sends no follow-up for a request that has ended or was never started', async () => {
    const l = await launcher();
    l.send(hello());
    l.send(measure());
    await tick();
    const before = l.orders.length;
    link.followFile('files_cancel', 9999);
    await tick();
    expect(l.orders.length).toBe(before);
  });

  it('answers launcher_lost at once with no launcher, and to every open request when the link is lost', async () => {
    const early: Got[] = [];
    link.startFile({ kind: 'files_list', path: '' }, (r) => void early.push(r));
    await tick();
    expect(early).toEqual([
      expect.objectContaining({ kind: 'reply', ok: false, code: 'launcher_lost' }),
    ]);

    const l = await launcher();
    l.send(hello());
    l.send(measure());
    await tick();
    const open: Got[] = [];
    link.startFile(
      { kind: 'files_read', path: 'a', offset: 0, length: 1 },
      (r) => void open.push(r)
    );
    await tick();
    l.socket.destroy();
    await l.closed;
    await tick();
    expect(open).toEqual([
      expect.objectContaining({ kind: 'reply', ok: false, code: 'launcher_lost' }),
    ]);
  });

  it('keeps ordinary orders’ replies apart from file requests', async () => {
    const l = await launcher();
    l.send(hello());
    l.send(measure());
    await tick();
    const files: Got[] = [];
    const fileId = link.startFile({ kind: 'files_list', path: '' }, (r) => void files.push(r));
    const answer = link.order({ kind: 'observe', agentId: AGENT });
    await tick();
    const orderId = (l.orders.at(-1) as { id: number }).id;
    l.send(encodeLine({ kind: 'reply', id: orderId, ok: true, observation: {} }));
    l.send(encodeLine({ kind: 'reply', id: fileId, ok: true, listing: { entries: [] } }));
    expect((await answer).ok).toBe(true);
    await tick();
    expect(files).toEqual([expect.objectContaining({ kind: 'reply', id: fileId, ok: true })]);
  });
});
