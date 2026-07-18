import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookEventLog, HookServer, type RawHookRequest } from '@main/core/agent-hooks/hook-server';
import { RemoteHookEventRelay } from './remote-hook-event-relay';

const serverLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const noopLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
const raw = (n: number): RawHookRequest => ({ ptyId: `pty-${n}`, type: 'status', body: `b${n}` });

/**
 * Connect to a local TCP port, resolving only once the socket is open (or
 * rejecting on failure) — mirroring SSH forwardOut, which resolves a channel
 * only when it opens. Stands in for the SSH-forwarded channel in tests.
 */
function connectChannel(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => resolve(socket));
    socket.once('error', (err) => reject(err));
  });
}

const localOpener = { openChannel: (port: number) => connectChannel(port) };

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('RemoteHookEventRelay', () => {
  let server: HookServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
  });

  it('drains buffered sidecar events and replays them through the sink in order', async () => {
    const eventLog = new HookEventLog();
    eventLog.append(raw(1));
    eventLog.append(raw(2));
    server = new HookServer(serverLog);
    await server.start(async () => {}, { eventLog });

    const seen: RawHookRequest[] = [];
    const relay = new RemoteHookEventRelay({
      opener: localOpener,
      port: server.getPort(),
      token: server.getToken(),
      sink: async (r) => {
        seen.push(r);
      },
      log: noopLog,
    });
    relay.start();

    await waitFor(() => seen.length >= 2);
    relay.stop();

    expect(seen.map((r) => r.ptyId)).toEqual(['pty-1', 'pty-2']);
  });

  it('advances its cursor so a later append is delivered exactly once', async () => {
    const eventLog = new HookEventLog();
    eventLog.append(raw(1));
    server = new HookServer(serverLog);
    await server.start(async () => {}, { eventLog });

    const seen: RawHookRequest[] = [];
    const relay = new RemoteHookEventRelay({
      opener: localOpener,
      port: server.getPort(),
      token: server.getToken(),
      sink: async (r) => {
        seen.push(r);
      },
      log: noopLog,
    });
    relay.start();

    await waitFor(() => seen.length >= 1);
    eventLog.append(raw(2));
    await waitFor(() => seen.length >= 2);
    relay.stop();

    expect(seen.map((r) => r.ptyId)).toEqual(['pty-1', 'pty-2']);
  });

  it('retries after a poll failure', async () => {
    const eventLog = new HookEventLog();
    eventLog.append(raw(1));
    server = new HookServer(serverLog);
    await server.start(async () => {}, { eventLog });
    const goodPort = server.getPort();
    const token = server.getToken();

    // First openChannel points at a dead port (connection refused), then recovers.
    let attempt = 0;
    const openChannel = (): Promise<net.Socket> => {
      attempt += 1;
      return connectChannel(attempt === 1 ? 1 : goodPort);
    };

    const seen: RawHookRequest[] = [];
    const relay = new RemoteHookEventRelay({
      opener: { openChannel },
      port: goodPort,
      token,
      sink: async (r) => {
        seen.push(r);
      },
      log: noopLog,
      sleep: async () => {},
    });
    relay.start();

    await waitFor(() => seen.length >= 1);
    relay.stop();

    expect(attempt).toBeGreaterThan(1);
    expect(seen.map((r) => r.ptyId)).toEqual(['pty-1']);
  });
});

function httpResponse(payload: unknown): string {
  const body = JSON.stringify(payload);
  return (
    `HTTP/1.1 200 OK\r\n` +
    `content-type: application/json\r\n` +
    `content-length: ${Buffer.byteLength(body)}\r\n` +
    `\r\n${body}`
  );
}

/**
 * A stand-in for an ssh2 forwarded channel. Streams the response in arbitrary
 * chunks and never emits `close` (its own write side is never finished). It
 * optionally fires `end` after the data, but with the body's `Content-Length`
 * the relay must finish before then — so this exercises both the "no close"
 * production behavior and a body split across multiple `data` chunks. `net.Socket`
 * (used in the other tests) hides the no-close case by auto-ending on EOF.
 */
class ChunkedChannel extends EventEmitter {
  constructor(
    private readonly chunks: string[],
    private readonly emitEnd: boolean
  ) {
    super();
  }
  write(_request: string): void {
    setImmediate(() => {
      for (const chunk of this.chunks) this.emit('data', Buffer.from(chunk, 'utf8'));
      if (this.emitEnd) this.emit('end');
      // Deliberately no 'close'.
    });
  }
  destroy(): void {}
}

describe('RemoteHookEventRelay channel half-close', () => {
  it('finishes on Content-Length when the channel never emits `close`', async () => {
    const response = httpResponse({
      events: [{ seq: 1, ptyId: 'pty-end', type: 'status', body: 'b1' }],
      oldestSeq: 1,
      latestSeq: 1,
    });

    const seen: RawHookRequest[] = [];
    const relay = new RemoteHookEventRelay({
      // No `end`, no `close` — only Content-Length can complete the read.
      opener: {
        openChannel: async () => new ChunkedChannel([response], false) as unknown as Duplex,
      },
      port: 1234,
      token: 'tok',
      sink: async (r) => {
        seen.push(r);
      },
      log: noopLog,
      sleep: async () => {},
    });
    relay.start();

    await waitFor(() => seen.length >= 1);
    relay.stop();

    expect(seen.map((r) => r.ptyId)).toEqual(['pty-end']);
  });

  it('reassembles a response split across multiple data chunks', async () => {
    const response = httpResponse({
      events: [{ seq: 1, ptyId: 'pty-split', type: 'status', body: 'b1' }],
      oldestSeq: 1,
      latestSeq: 1,
    });
    // Split mid-headers and mid-body to prove partial reads don't parse early.
    const chunks = [response.slice(0, 12), response.slice(12, 60), response.slice(60)];

    const seen: RawHookRequest[] = [];
    const relay = new RemoteHookEventRelay({
      opener: { openChannel: async () => new ChunkedChannel(chunks, false) as unknown as Duplex },
      port: 1234,
      token: 'tok',
      sink: async (r) => {
        seen.push(r);
      },
      log: noopLog,
      sleep: async () => {},
    });
    relay.start();

    await waitFor(() => seen.length >= 1);
    relay.stop();

    expect(seen.map((r) => r.ptyId)).toEqual(['pty-split']);
  });
});

describe('RemoteHookEventRelay gap detection', () => {
  it('warns when the consumer falls behind the ring buffer', async () => {
    const warn = vi.fn();
    const log = { debug: vi.fn(), info: vi.fn(), warn };

    // A stub server returns a response with a gap: oldestSeq jumps past the cursor.
    const stub = http.createServer((req, res) => {
      const since = Number(new URL(req.url ?? '', 'http://x').searchParams.get('since'));
      const body =
        since === 0
          ? JSON.stringify({
              events: [{ seq: 1, ptyId: 'p1', type: 't', body: '' }],
              oldestSeq: 1,
              latestSeq: 1,
            })
          : // Cursor is 1, but the oldest retained is 5 — events 2..4 were evicted.
            JSON.stringify({
              events: [{ seq: 5, ptyId: 'p5', type: 't', body: '' }],
              oldestSeq: 5,
              latestSeq: 5,
            });
      const payload = Buffer.from(body, 'utf8');
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': payload.byteLength,
      });
      res.end(payload);
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const port = (stub.address() as net.AddressInfo).port;

    const seen: RawHookRequest[] = [];
    const relay = new RemoteHookEventRelay({
      opener: { openChannel: connectChannel },
      port,
      token: 'tok',
      sink: async (r) => {
        seen.push(r);
      },
      log,
      sleep: async () => {},
    });
    relay.start();

    await waitFor(() => seen.some((r) => r.ptyId === 'p5'));
    relay.stop();
    await new Promise<void>((resolve) => stub.close(() => resolve()));

    expect(warn).toHaveBeenCalledWith(
      'RemoteHookEventRelay: dropped events (consumer fell behind ring buffer)',
      expect.objectContaining({ dropped: 3 })
    );
  });
});
