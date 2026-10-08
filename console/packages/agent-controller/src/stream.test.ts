import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AccessTokens,
  ControllerApiError,
  ControllerClient,
  type OpenedSocket,
  type SocketLike,
} from './api';
import { DEFAULT_TIMING } from './controller';
import { silentLogger } from './log';
import type { AgentCursor, ControllerConnection } from './schemas';
import { type ControllerFrame, type ControllerStreamOptions, runControllerStream } from './stream';
import { FakeCore } from './testing/fake-core';

type Message = { event: string; data: unknown };

/**
 * A socket that opens, delivers `messages` one per turn of the event loop,
 * then closes with `end` (or stays open). What the controller sends is kept
 * in `sent`, and `deliver` adds more as the test goes.
 */
class ScriptedSocket extends EventTarget {
  readyState = 0;
  readonly sent: unknown[] = [];

  constructor(messages: (Message | string)[], end: number | 'open') {
    super();
    setImmediate(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
      for (const message of messages) this.deliver(message);
      if (end !== 'open') this.end(end);
    });
  }

  deliver(message: Message | string): void {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    setImmediate(() => {
      if (this.readyState !== 3) this.dispatchEvent(Object.assign(new Event('message'), { data }));
    });
  }

  end(code: number): void {
    setImmediate(() => {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(Object.assign(new Event('close'), { code }));
    });
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000): void {
    this.end(code);
  }
}

function scriptedSocket(messages: (Message | string)[], end: number | 'open'): ScriptedSocket {
  return new ScriptedSocket(messages, end);
}

const state: Message = { event: 'connection_state', data: { connection_id: 'connection-1' } };

function refused(status: number, code: string): Message {
  return { event: 'refused', data: { status, detail: { code, message: code } } };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(5);
  }
}

const opened: ControllerConnection = {
  connection_id: 'connection-1',
  generation: 1,
  heartbeat_interval_s: 0.02,
  agents: ['agent-1'],
};

/** A client that answers from scripts, recording what it was asked. */
class ScriptedClient {
  opens: Record<string, AgentCursor>[] = [];
  attaches: { connectionId: string; generation: number }[] = [];
  opened: ScriptedSocket[] = [];
  staleTokens = 0;
  open: () => Promise<ControllerConnection> = async () => opened;
  sockets: () => ScriptedSocket = () => scriptedSocket([], 'open');

  readonly client: ControllerStreamOptions['client'] = {
    openConnection: async (cursors) => {
      this.opens.push(cursors);
      return this.open();
    },
    openSocket: async (connection): Promise<OpenedSocket> => {
      this.attaches.push(connection);
      const socket = this.sockets();
      this.opened.push(socket);
      return {
        socket: socket as unknown as SocketLike,
        tokenRefused: () => void this.staleTokens++,
      };
    },
  };
}

function run(
  scripted: ScriptedClient,
  signal: AbortSignal,
  overrides: Partial<ControllerStreamOptions> = {}
) {
  const frames: ControllerFrame[] = [];
  const states: string[] = [];
  const ending = runControllerStream({
    client: scripted.client,
    cursors: () => ({ 'agent-1': 7 }),
    confirmed: () => ({ 'agent-1': 7 }),
    onOpened: (connection) => void states.push(`opened ${connection.connection_id}`),
    onConnected: () => void states.push('connected'),
    onDisconnected: () => void states.push('disconnected'),
    onFrame: async (frame) => void frames.push(frame),
    signal,
    log: silentLogger,
    idleTimeoutMs: 200,
    initialBackoffMs: 5,
    maxBackoffMs: 20,
    random: () => 0,
    ...overrides,
  });
  return { frames, states, ending };
}

describe('runControllerStream', () => {
  it('opens with the cursors, attaches, and hands over typed frames in order, skipping bad ones', async () => {
    const scripted = new ScriptedClient();
    scripted.sockets = () =>
      scriptedSocket(
        [
          { event: 'ping', data: {} },
          'not json',
          {
            event: 'agent.attached',
            data: { agent_id: 'agent-1', from_seq: 7, rooms: ['room-a'] },
          },
          { event: 'agent.event', data: { agent_id: 'agent-1' } },
          { event: 'agent.unknown', data: { agent_id: 'agent-1' } },
          {
            event: 'agent.event',
            data: {
              agent_id: 'agent-1',
              seq: 8,
              event: {
                type: 'message',
                room_id: 'room-a',
                sequence: 8,
                payload: { addressed: true },
                future: 1,
              },
            },
          },
          { event: 'assignment.changed', data: { revision: 2 } },
          {
            event: 'operation.pending',
            data: { operation_id: 'op-1', kind: 'agent.restart', agent_id: null },
          },
        ],
        'open'
      );
    const stop = new AbortController();
    const { frames, states, ending } = run(scripted, stop.signal);
    await waitFor(() => frames.length === 4, 'four frames');
    stop.abort();
    expect(await ending).toBe('stopped');
    expect(scripted.opens).toEqual([{ 'agent-1': 7 }]);
    expect(scripted.attaches[0]).toMatchObject({ connectionId: 'connection-1', generation: 1 });
    expect(states.slice(0, 2)).toEqual(['opened connection-1', 'connected']);
    expect(frames.map((frame) => frame.type)).toEqual([
      'agent.attached',
      'agent.event',
      'assignment.changed',
      'operation.pending',
    ]);
    expect(frames[1]!.data).toMatchObject({ seq: 8, event: { future: 1 } });
  });

  it('answers every ping with a pong naming the confirmed cursors: its beat', async () => {
    const scripted = new ScriptedClient();
    const ping = { event: 'ping', data: {} };
    scripted.sockets = () => scriptedSocket([state, ping, ping], 'open');
    const stop = new AbortController();
    const { ending } = run(scripted, stop.signal);
    await waitFor(() => (scripted.opened[0]?.sent.length ?? 0) >= 2, 'two pongs');
    stop.abort();
    await ending;
    expect(scripted.opened[0]!.sent[0]).toEqual({ type: 'pong', cursors: { 'agent-1': 7 } });
  });

  it('reattaches to the same connection after the socket closes', async () => {
    const scripted = new ScriptedClient();
    scripted.sockets = () => scriptedSocket([state], 1000);
    const stop = new AbortController();
    const { states, ending } = run(scripted, stop.signal);
    await waitFor(() => scripted.attaches.length >= 3, 'three attaches');
    stop.abort();
    await ending;
    expect(scripted.opens).toHaveLength(1);
    expect(new Set(scripted.attaches.map((a) => a.connectionId))).toEqual(
      new Set(['connection-1'])
    );
    expect(states).toContain('disconnected');
  });

  it('comes back within a second, without backing off, when the server is restarting', async () => {
    const scripted = new ScriptedClient();
    scripted.sockets = () => scriptedSocket([state], 1012);
    const stop = new AbortController();
    const started = Date.now();
    const { ending } = run(scripted, stop.signal, { initialBackoffMs: 60_000 });
    await waitFor(() => scripted.attaches.length >= 3, 'three attaches', 3_000);
    stop.abort();
    await ending;
    expect(Date.now() - started).toBeGreaterThanOrEqual(490);
  });

  it('reconnects when nothing arrives within the idle timeout', async () => {
    const scripted = new ScriptedClient();
    const started = Date.now();
    const stop = new AbortController();
    const { ending } = run(scripted, stop.signal);
    await waitFor(() => scripted.attaches.length >= 2, 'a second attach');
    stop.abort();
    await ending;
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it('opens a new connection, from the cursors as they stand, when Switch no longer knows it', async () => {
    const scripted = new ScriptedClient();
    scripted.sockets = () =>
      scriptedSocket(
        scripted.attaches.length === 2 ? [refused(404, 'unknown_connection')] : [state],
        scripted.attaches.length === 2 ? 4404 : 1000
      );
    let cursor = 7;
    const stop = new AbortController();
    const { ending } = run(scripted, stop.signal, {
      cursors: () => ({ 'agent-1': cursor++ }),
    });
    await waitFor(() => scripted.opens.length === 2, 'a second open');
    stop.abort();
    await ending;
    expect(scripted.opens).toEqual([{ 'agent-1': 7 }, { 'agent-1': 8 }]);
  });

  it('opens a new connection when an attach is refused as stale', async () => {
    const scripted = new ScriptedClient();
    scripted.sockets = () => scriptedSocket([refused(409, 'stale_generation')], 4409);
    const stop = new AbortController();
    const { ending } = run(scripted, stop.signal);
    await waitFor(() => scripted.opens.length >= 2, 'a second open');
    stop.abort();
    await ending;
  });

  it('opens a new connection when Switch evicts it for any reason but a takeover', async () => {
    const scripted = new ScriptedClient();
    scripted.sockets = () =>
      scriptedSocket(
        [state, { event: 'evicted', data: { code: 'no_stream', reason: 'beat refused' } }],
        1000
      );
    const stop = new AbortController();
    const { ending } = run(scripted, stop.signal);
    await waitFor(() => scripted.opens.length >= 2, 'a second open');
    stop.abort();
    expect(await ending).toBe('stopped');
  });

  it('stops for good when another instance took the connection over', async () => {
    const evicted = new ScriptedClient();
    evicted.sockets = () =>
      scriptedSocket(
        [state, { event: 'evicted', data: { code: 'taken_over', reason: 'x' } }],
        1000
      );
    expect(await run(evicted, new AbortController().signal).ending).toBe('taken_over');
    const refusedAttach = new ScriptedClient();
    refusedAttach.sockets = () => scriptedSocket([refused(409, 'taken_over')], 4409);
    expect(await run(refusedAttach, new AbortController().signal).ending).toBe('taken_over');
  });

  it('ends as revoked on the frame, on a refused open, and on a refused attach', async () => {
    const framed = new ScriptedClient();
    framed.sockets = () => scriptedSocket([{ event: 'credential.revoked', data: {} }], 'open');
    const first = run(framed, new AbortController().signal);
    expect(await first.ending).toBe('revoked');
    expect(first.frames.map((frame) => frame.type)).toEqual(['credential.revoked']);

    const refusedOpen = new ScriptedClient();
    refusedOpen.open = async () => {
      throw new ControllerApiError(401, 'controller_revoked', 'revoked', false, null);
    };
    expect(await run(refusedOpen, new AbortController().signal).ending).toBe('revoked');

    const refusedAttach = new ScriptedClient();
    refusedAttach.sockets = () => scriptedSocket([refused(401, 'controller_revoked')], 4401);
    const third = run(refusedAttach, new AbortController().signal);
    expect(await third.ending).toBe('revoked');
    expect(refusedAttach.staleTokens).toBe(0);
  });

  it('stops for good when the server refuses its protocol, on open and on attach', async () => {
    const refusedOpen = new ScriptedClient();
    let opens = 0;
    refusedOpen.open = async () => {
      opens++;
      throw new ControllerApiError(426, 'protocol_unsupported', 'protocol 1', false, null);
    };
    expect(await run(refusedOpen, new AbortController().signal).ending).toBe('upgrade_required');
    expect(opens).toBe(1);

    const refusedAttach = new ScriptedClient();
    refusedAttach.sockets = () => scriptedSocket([refused(426, 'protocol_unsupported')], 4426);
    expect(await run(refusedAttach, new AbortController().signal).ending).toBe('upgrade_required');
  });

  it('stops for good when the server knows no controller by its credential', async () => {
    const scripted = new ScriptedClient();
    let opens = 0;
    scripted.open = async () => {
      opens++;
      throw new ControllerApiError(401, 'invalid_credential', 'not valid', false, null);
    };
    expect(await run(scripted, new AbortController().signal).ending).toBe('credential_invalid');
    expect(opens).toBe(1);
  });

  it('drops a token the socket refused as stale, and attaches again', async () => {
    const scripted = new ScriptedClient();
    scripted.sockets = () =>
      scripted.attaches.length === 1
        ? scriptedSocket([refused(401, 'token_expired')], 4401)
        : scriptedSocket([state], 'open');
    const stop = new AbortController();
    const { states, ending } = run(scripted, stop.signal);
    await waitFor(() => states.includes('connected'), 'a connection');
    stop.abort();
    await ending;
    expect(scripted.staleTokens).toBe(1);
    expect(scripted.opens).toHaveLength(1);
  });

  it('keeps retrying an open that fails', async () => {
    const scripted = new ScriptedClient();
    let opens = 0;
    scripted.open = async () => {
      opens++;
      if (opens < 3) throw new TypeError('fetch failed');
      return opened;
    };
    scripted.sockets = () => scriptedSocket([state], 'open');
    const stop = new AbortController();
    const { states, ending } = run(scripted, stop.signal);
    await waitFor(() => states.includes('connected'), 'a connection');
    stop.abort();
    await ending;
    expect(opens).toBe(3);
  });

  it('waits less each time a socket attached, however briefly, and never long', async () => {
    const scripted = new ScriptedClient();
    let opens = 0;
    scripted.open = async () => {
      opens++;
      if (opens <= 3) throw new TypeError('fetch failed');
      return opened;
    };
    scripted.sockets = () =>
      scripted.attaches.length === 1 ? scriptedSocket([state], 1000) : scriptedSocket([], 1006);
    const waits: number[] = [];
    const log = {
      ...silentLogger,
      warn: (_message: string, fields?: Record<string, unknown>) => {
        if (typeof fields?.retryInMs === 'number') waits.push(fields.retryInMs);
      },
    };
    const stop = new AbortController();
    const { ending } = run(scripted, stop.signal, {
      log,
      initialBackoffMs: 8,
      maxBackoffMs: 64,
    });
    await waitFor(() => waits.length >= 5, 'five reconnect waits');
    stop.abort();
    await ending;
    // Doubling from the start after the socket that attached, capped, with
    // jitter taking half off (random() is 0 here).
    expect(waits.slice(0, 5)).toEqual([4, 8, 16, 8, 16]);
  });

  it('caps the reconnect wait at seconds, not a minute', () => {
    expect(DEFAULT_TIMING.streamInitialBackoffMs).toBeLessThanOrEqual(1_000);
    expect(DEFAULT_TIMING.streamMaxBackoffMs).toBeLessThanOrEqual(10_000);
  });

  const fixture = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    'core',
    'tests',
    'switch_core',
    'fixtures',
    'agent_controllers',
    'stream_frames.json'
  );

  it.skipIf(!existsSync(fixture))('reads every frame in Core’s stream fixture', async () => {
    const fixtureFrames = JSON.parse(readFileSync(fixture, 'utf8')) as {
      event: string;
      data: unknown;
    }[];
    const scripted = new ScriptedClient();
    scripted.sockets = () => scriptedSocket(fixtureFrames, 'open');
    const stop = new AbortController();
    const { frames, ending } = run(scripted, stop.signal);
    await waitFor(
      () => frames.length === fixtureFrames.length || frames.at(-1)?.type === 'credential.revoked',
      'every fixture frame'
    );
    stop.abort();
    await ending;
    expect(frames.map((frame) => frame.type)).toEqual(
      fixtureFrames
        .map((frame) => frame.event)
        .slice(
          0,
          fixtureFrames.findIndex((frame) => frame.event === 'credential.revoked') + 1 || undefined
        )
    );
  });
});

describe('runControllerStream against the controller routes', () => {
  let core: FakeCore;

  beforeEach(async () => {
    core = new FakeCore();
    await core.start();
  });

  afterEach(async () => {
    await core.stop();
  });

  function client(): ControllerClient {
    return new ControllerClient({
      fetch,
      server: core.url,
      controllerId: core.controllerId,
      version: '0.1.0',
      openWebSocket: core.openWebSocket,
      tokens: new AccessTokens({
        fetch,
        server: core.url,
        controllerId: core.controllerId,
        credential: async () => core.credential,
        now: Date.now,
        log: silentLogger,
      }),
    });
  }

  it('opens, reads, pongs, reattaches, and reopens with cursors after the connection lapses', async () => {
    let confirmed = 3;
    const frames: ControllerFrame[] = [];
    const stop = new AbortController();
    const ending = runControllerStream({
      client: client(),
      cursors: () => ({ 'agent-1': confirmed }),
      confirmed: () => ({ 'agent-1': confirmed }),
      onOpened: () => {},
      onConnected: () => {},
      onDisconnected: () => {},
      onFrame: async (frame) => void frames.push(frame),
      signal: stop.signal,
      log: silentLogger,
      // Long enough that a loaded machine does not lapse the socket before the test does.
      idleTimeoutMs: 30_000,
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      random: () => 0,
    });
    await waitFor(() => core.streamCount === 1, 'the socket');
    core.push('assignment.changed', { revision: 4 });
    await waitFor(
      () => frames.some((frame) => frame.type === 'assignment.changed'),
      'the pushed frame'
    );
    await waitFor(() => core.beats.length > 0, 'a pong');
    expect(core.beats[0]).toEqual({ 'agent-1': 3 });

    core.closeStreams();
    await waitFor(() => core.streamCount === 1, 'the socket reattached');
    expect(core.opens).toHaveLength(1);

    confirmed = 9;
    core.forgetConnection();
    await waitFor(() => core.opens.length === 2, 'a new connection');
    expect(core.opens[1]).toEqual({ 'agent-1': 9 });
    stop.abort();
    expect(await ending).toBe('stopped');
  });
});
