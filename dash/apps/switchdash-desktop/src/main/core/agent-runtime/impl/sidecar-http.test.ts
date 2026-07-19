import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { httpGetJsonOverChannel, httpPostJsonOverChannel } from './sidecar-http';

/**
 * A minimal duplex stand-in: the request write is discarded, and the readable
 * side is driven by emitting 'data' — unlike PassThrough, which would echo the
 * request bytes back as the response.
 */
function fakeChannel(): Duplex {
  const emitter = new EventEmitter() as EventEmitter & Duplex;
  emitter.write = (() => true) as Duplex['write'];
  emitter.destroy = (() => emitter) as Duplex['destroy'];
  return emitter;
}

function httpResponse(body: string, status = 200): string {
  const payload = Buffer.from(body, 'utf8');
  return (
    `HTTP/1.1 ${status} OK\r\n` +
    `content-type: application/json\r\n` +
    `content-length: ${payload.byteLength}\r\n\r\n` +
    body
  );
}

describe('httpGetJsonOverChannel', () => {
  it('parses a JSON body once Content-Length bytes have arrived', async () => {
    const channel = fakeChannel();
    const promise = httpGetJsonOverChannel<{ sessions: string[] }>(channel, {
      port: 1234,
      token: 'tok',
      path: '/sessions',
      timeoutMs: 1000,
    });
    channel.emit('data', Buffer.from(httpResponse(JSON.stringify({ sessions: ['a', 'b'] }))));
    await expect(promise).resolves.toEqual({ sessions: ['a', 'b'] });
  });

  it('reassembles a body split across multiple chunks', async () => {
    const channel = fakeChannel();
    const promise = httpGetJsonOverChannel<{ ok: boolean }>(channel, {
      port: 1234,
      token: 'tok',
      path: '/sessions',
      timeoutMs: 1000,
    });
    const full = httpResponse(JSON.stringify({ ok: true }));
    const split = Math.floor(full.length / 2);
    channel.emit('data', Buffer.from(full.slice(0, split)));
    await new Promise((r) => setTimeout(r, 5));
    channel.emit('data', Buffer.from(full.slice(split)));
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('rejects on a non-200 status', async () => {
    const channel = fakeChannel();
    const promise = httpGetJsonOverChannel(channel, {
      port: 1234,
      token: 'tok',
      path: '/sessions',
      timeoutMs: 1000,
    });
    channel.emit('data', Buffer.from(httpResponse('nope', 403)));
    await expect(promise).rejects.toThrow(/status 403/);
  });
});

/** Like fakeChannel but records the bytes written so the request can be asserted. */
function recordingChannel(): Duplex & { written: string } {
  const emitter = new EventEmitter() as EventEmitter & Duplex & { written: string };
  emitter.written = '';
  emitter.write = ((chunk: string | Buffer) => {
    emitter.written += chunk.toString();
    return true;
  }) as Duplex['write'];
  emitter.destroy = (() => emitter) as never;
  return emitter;
}

describe('httpPostJsonOverChannel', () => {
  it('writes a POST with the JSON body and resolves on a 2xx', async () => {
    const channel = recordingChannel();
    const promise = httpPostJsonOverChannel(channel, {
      port: 1234,
      token: 'tok',
      path: '/disconnect',
      body: { sessionId: 'session-1' },
      timeoutMs: 1000,
    });
    expect(channel.written).toContain('POST /disconnect HTTP/1.1');
    expect(channel.written).toContain('x-switchdash-token: tok');
    expect(channel.written).toContain('{"sessionId":"session-1"}');
    channel.emit('data', Buffer.from('HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n'));
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects on a non-2xx status', async () => {
    const channel = recordingChannel();
    const promise = httpPostJsonOverChannel(channel, {
      port: 1234,
      token: 'tok',
      path: '/disconnect',
      body: {},
      timeoutMs: 1000,
    });
    channel.emit('data', Buffer.from('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n'));
    await expect(promise).rejects.toThrow(/status 400/);
  });
});
