import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessTokens, ControllerApiError, ControllerClient } from './api';
import { DEFAULT_TIMING } from './controller';
import { silentLogger } from './log';
import type { AgentCursor, ControllerConnection } from './schemas';
import {
  type ControllerFrame,
  type ControllerStreamOptions,
  parseSse,
  runControllerStream,
  type SseItem,
} from './stream';
import { FakeCore } from './testing/fake-core';

function streamOf(chunks: string[], keepOpen = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!keepOpen) controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SseItem[]> {
  const items: SseItem[] = [];
  for await (const item of parseSse(body)) items.push(item);
  return items;
}

describe('parseSse', () => {
  it('reads events, comments and multi-line data', async () => {
    expect(
      await collect(
        streamOf([': keepalive\n\n', 'event: a\ndata: {"x":1}\n\n', 'data: line1\ndata: line2\n\n'])
      )
    ).toEqual([
      { kind: 'comment', text: 'keepalive' },
      { kind: 'event', event: 'a', data: '{"x":1}', id: null },
      { kind: 'event', event: 'message', data: 'line1\nline2', id: null },
    ]);
  });

  it('handles CRLF, fields without a space, and frames split across chunks', async () => {
    expect(
      await collect(streamOf(['event:b\r', '\ndata:{"y"', ':2}\r\nid: 7\r\n', '\r\n']))
    ).toEqual([{ kind: 'event', event: 'b', data: '{"y":2}', id: '7' }]);
  });

  it('drops a trailing frame the stream never finished', async () => {
    expect(await collect(streamOf(['event: c\ndata: {}\n']))).toEqual([]);
  });
});

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
  beats: Record<string, number>[] = [];
  placementsSent: Record<string, string[]>[] = [];
  open: () => Promise<ControllerConnection> = async () => opened;
  events: () => Promise<Response> = async () => new Response(streamOf([], true));
  beat: () => Promise<void> = async () => {};

  readonly client: ControllerStreamOptions['client'] = {
    openConnection: async (cursors, placements) => {
      this.opens.push(cursors);
      this.placementsSent.push(placements);
      return this.open();
    },
    openEvents: async (connection) => {
      this.attaches.push(connection);
      return this.events();
    },
    beat: async (_connection, cursors, placements) => {
      this.beats.push(cursors);
      this.placementsSent.push(placements);
      return this.beat();
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
    placements: () => ({}),
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
    scripted.events = async () =>
      new Response(
        streamOf(
          [
            ': ping\n\n',
            sse('agent.attached', { agent_id: 'agent-1', from_seq: 7, rooms: ['room-a'] }),
            sse('agent.event', { agent_id: 'agent-1' }),
            sse('agent.unknown', { agent_id: 'agent-1' }),
            sse('agent.event', {
              agent_id: 'agent-1',
              seq: 8,
              event: {
                type: 'message',
                room_id: 'room-a',
                sequence: 8,
                payload: { addressed: true },
                future: 1,
              },
            }),
            sse('assignment.changed', { revision: 2 }),
            sse('operation.pending', {
              operation_id: 'op-1',
              kind: 'agent.restart',
              agent_id: null,
            }),
          ],
          true
        )
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

  it('beats the connection with the confirmed cursors while attached', async () => {
    const scripted = new ScriptedClient();
    const stop = new AbortController();
    const { ending } = run(scripted, stop.signal);
    await waitFor(() => scripted.beats.length >= 2, 'two beats');
    stop.abort();
    await ending;
    expect(scripted.beats[0]).toEqual({ 'agent-1': 7 });
  });

  it('states the current placements on the open and on every beat, as they change', async () => {
    const scripted = new ScriptedClient();
    let current: Record<string, string[]> = { 'agent-1': ['room-a'] };
    const stop = new AbortController();
    const { ending } = run(scripted, stop.signal, { placements: () => current });
    await waitFor(() => scripted.beats.length >= 1, 'a beat');
    current = {};
    const sent = scripted.placementsSent.length;
    await waitFor(() => scripted.placementsSent.length > sent, 'the next beat');
    stop.abort();
    await ending;
    expect(scripted.placementsSent[0]).toEqual({ 'agent-1': ['room-a'] });
    expect(scripted.placementsSent.at(-1)).toEqual({});
  });

  it('reattaches to the same connection after the stream ends', async () => {
    const scripted = new ScriptedClient();
    scripted.events = async () => new Response(streamOf([': ping\n\n']));
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
    let attaches = 0;
    scripted.events = async () => {
      attaches++;
      if (attaches === 2)
        throw new ControllerApiError(404, 'unknown_connection', 'gone', false, null);
      return new Response(streamOf([]));
    };
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

  it('opens a new connection when the heartbeat is refused as stale', async () => {
    const scripted = new ScriptedClient();
    let beats = 0;
    scripted.beat = async () => {
      beats++;
      if (beats === 1) throw new ControllerApiError(409, 'stale_generation', 'old', false, null);
    };
    const stop = new AbortController();
    const { ending } = run(scripted, stop.signal);
    await waitFor(() => scripted.opens.length === 2, 'a second open');
    stop.abort();
    await ending;
  });

  it('opens a new connection when Switch ends the stream for any reason but a takeover', async () => {
    const scripted = new ScriptedClient();
    scripted.events = async () =>
      new Response(
        streamOf([sse('evicted', { code: 'heartbeat_lapsed', reason: 'lapsed' })], true)
      );
    const stop = new AbortController();
    const { ending } = run(scripted, stop.signal);
    await waitFor(() => scripted.opens.length === 2, 'a second open');
    stop.abort();
    expect(await ending).toBe('stopped');
  });

  it('stops for good when another instance took the connection over', async () => {
    const evicted = new ScriptedClient();
    evicted.events = async () =>
      new Response(streamOf([sse('evicted', { code: 'taken_over', reason: 'x' })], true));
    expect(await run(evicted, new AbortController().signal).ending).toBe('taken_over');
    const scripted = new ScriptedClient();
    scripted.beat = async () => {
      throw new ControllerApiError(409, 'taken_over', 'someone else', false, null);
    };
    expect(await run(scripted, new AbortController().signal).ending).toBe('taken_over');
    const refused = new ScriptedClient();
    refused.events = async () => {
      throw new ControllerApiError(409, 'taken_over', 'someone else', false, null);
    };
    expect(await run(refused, new AbortController().signal).ending).toBe('taken_over');
  });

  it('ends as revoked on the frame, on a refused open, and on a refused beat', async () => {
    const framed = new ScriptedClient();
    framed.events = async () => new Response(streamOf([sse('credential.revoked', {})], true));
    const first = run(framed, new AbortController().signal);
    expect(await first.ending).toBe('revoked');
    expect(first.frames.map((frame) => frame.type)).toEqual(['credential.revoked']);

    const refused = new ScriptedClient();
    refused.open = async () => {
      throw new ControllerApiError(401, 'controller_revoked', 'revoked', false, null);
    };
    expect(await run(refused, new AbortController().signal).ending).toBe('revoked');

    const beaten = new ScriptedClient();
    beaten.beat = async () => {
      throw new ControllerApiError(401, 'controller_revoked', 'revoked', false, null);
    };
    expect(await run(beaten, new AbortController().signal).ending).toBe('revoked');
  });

  it('keeps retrying an open that fails', async () => {
    const scripted = new ScriptedClient();
    let opens = 0;
    scripted.open = async () => {
      opens++;
      if (opens < 3) throw new TypeError('fetch failed');
      return opened;
    };
    const stop = new AbortController();
    const { states, ending } = run(scripted, stop.signal);
    await waitFor(() => states.includes('connected'), 'a connection');
    stop.abort();
    await ending;
    expect(opens).toBe(3);
  });

  it('waits less each time a stream attached, however briefly, and never long', async () => {
    const scripted = new ScriptedClient();
    let opens = 0;
    scripted.open = async () => {
      opens++;
      if (opens <= 3) throw new TypeError('fetch failed');
      return opened;
    };
    let attaches = 0;
    scripted.events = async () => {
      attaches++;
      if (attaches === 1) return new Response(streamOf([]));
      throw new TypeError('fetch failed');
    };
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
    // Doubling from the start after the stream that attached, capped, with
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
    scripted.events = async () =>
      new Response(
        streamOf(
          fixtureFrames.map((frame) => sse(frame.event, frame.data)),
          true
        )
      );
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

describe('runControllerStream against the controller stream routes', () => {
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

  it('opens, reads, beats, reattaches, and reopens with cursors after the connection lapses', async () => {
    let confirmed = 3;
    let placements: Record<string, string[]> = { 'agent-1': ['room-a'] };
    const frames: ControllerFrame[] = [];
    const stop = new AbortController();
    const ending = runControllerStream({
      client: client(),
      cursors: () => ({ 'agent-1': confirmed }),
      confirmed: () => ({ 'agent-1': confirmed }),
      placements: () => placements,
      onOpened: () => {},
      onConnected: () => {},
      onDisconnected: () => {},
      onFrame: async (frame) => void frames.push(frame),
      signal: stop.signal,
      log: silentLogger,
      // Long enough that a loaded machine does not lapse the stream before the test does.
      idleTimeoutMs: 30_000,
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      random: () => 0,
    });
    await waitFor(() => core.streamCount === 1, 'the stream');
    core.push('assignment.changed', { revision: 4 });
    await waitFor(() => frames.length === 1, 'the frame');
    await waitFor(() => core.beats.length > 0, 'a beat');
    expect(core.beats[0]).toEqual({ 'agent-1': 3 });
    expect(core.openPlacements[0]).toEqual({ 'agent-1': ['room-a'] });
    expect(core.beatPlacements[0]).toEqual({ 'agent-1': ['room-a'] });
    placements = { 'agent-1': ['room-a', 'room-b'] };
    // A beat already on its way still carries the old placements; the next one has the new.
    await waitFor(
      () =>
        JSON.stringify(core.beatPlacements.at(-1)) ===
        JSON.stringify({ 'agent-1': ['room-a', 'room-b'] }),
      'a beat with the new placements'
    );

    core.closeStreams();
    await waitFor(() => core.streamCount === 1, 'the stream reattached');
    expect(core.opens).toHaveLength(1);

    confirmed = 9;
    core.forgetConnection();
    await waitFor(() => core.opens.length === 2, 'a new connection');
    expect(core.opens[1]).toEqual({ 'agent-1': 9 });
    stop.abort();
    expect(await ending).toBe('stopped');
  });
});
