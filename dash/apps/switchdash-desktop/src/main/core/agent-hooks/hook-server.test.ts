import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookEventLog, HookServer, type RawHookRequest } from './hook-server';

const raw = (n: number): RawHookRequest => ({ ptyId: `pty-${n}`, type: 'status', body: `b${n}` });

const noopLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('HookEventLog', () => {
  it('tags appended events with a monotonic seq and returns those newer than the cursor', async () => {
    const logBuf = new HookEventLog();
    logBuf.append(raw(1));
    logBuf.append(raw(2));

    const result = await logBuf.poll(0, 1000);
    expect(result.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(result.oldestSeq).toBe(1);
    expect(result.latestSeq).toBe(2);

    const afterFirst = await logBuf.poll(1, 1000);
    expect(afterFirst.events.map((e) => e.seq)).toEqual([2]);
  });

  it('long-polls until the next append when nothing is newer', async () => {
    const logBuf = new HookEventLog();
    const pending = logBuf.poll(0, 5000);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    logBuf.append(raw(1));
    const result = await pending;
    expect(result.events.map((e) => e.seq)).toEqual([1]);
  });

  it('resolves empty after the timeout when no event arrives', async () => {
    const logBuf = new HookEventLog();
    const result = await logBuf.poll(0, 1);
    expect(result.events).toEqual([]);
    expect(result.latestSeq).toBe(0);
  });

  it('evicts the oldest events past capacity and surfaces the gap via oldestSeq', async () => {
    const logBuf = new HookEventLog(2);
    logBuf.append(raw(1));
    logBuf.append(raw(2));
    logBuf.append(raw(3));

    const result = await logBuf.poll(0, 1000);
    expect(result.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(result.oldestSeq).toBe(2); // seq 1 evicted — consumer at cursor 0 can detect the gap
    expect(result.latestSeq).toBe(3);
  });
});

describe('HookServer /events endpoint', () => {
  let server: HookServer;

  afterEach(() => {
    server?.stop();
  });

  function get(
    port: number,
    path: string,
    token: string
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path, method: 'GET', headers: { 'x-switchdash-token': token } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            body += c;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('serves buffered events as JSON and rejects a bad token', async () => {
    const eventLog = new HookEventLog();
    eventLog.append(raw(1));
    server = new HookServer(noopLog);
    await server.start(async () => {}, { eventLog });
    const port = server.getPort();
    const token = server.getToken();

    const ok = await get(port, '/events?since=0', token);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).events.map((e: { seq: number }) => e.seq)).toEqual([1]);

    const forbidden = await get(port, '/events?since=0', 'wrong-token');
    expect(forbidden.status).toBe(403);
  });

  it('does not serve /events when no event log is configured', async () => {
    server = new HookServer(noopLog);
    await server.start(async () => {});
    const res = await get(server.getPort(), '/events?since=0', server.getToken());
    expect(res.status).toBe(404);
  });

  it('serves the sessions snapshot as JSON and rejects a bad token', async () => {
    server = new HookServer(noopLog);
    await server.start(async () => {}, {
      sessionsProvider: () => [{ sessionId: 'conv-1', roomId: 'room-1' }],
    });
    const ok = await get(server.getPort(), '/sessions', server.getToken());
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).sessions).toEqual([{ sessionId: 'conv-1', roomId: 'room-1' }]);

    const forbidden = await get(server.getPort(), '/sessions', 'wrong-token');
    expect(forbidden.status).toBe(403);
  });

  it('does not serve /sessions when no provider is configured', async () => {
    server = new HookServer(noopLog);
    await server.start(async () => {});
    const res = await get(server.getPort(), '/sessions', server.getToken());
    expect(res.status).toBe(404);
  });

  function post(
    port: number,
    path: string,
    token: string,
    body: string
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { 'x-switchdash-token': token, 'content-type': 'application/json' },
        },
        (res) => {
          let out = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            out += c;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
        }
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  it('routes /disconnect to the handler and rejects a bad token', async () => {
    const disconnectHandler = vi.fn();
    server = new HookServer(noopLog);
    await server.start(async () => {}, { disconnectHandler });
    const port = server.getPort();
    const token = server.getToken();

    const ok = await post(port, '/disconnect', token, JSON.stringify({ sessionId: 'conv-1' }));
    expect(ok.status).toBe(200);
    expect(disconnectHandler).toHaveBeenCalledWith('conv-1', false);

    const terminated = await post(
      port,
      '/disconnect',
      token,
      JSON.stringify({ sessionId: 'conv-2', terminated: true })
    );
    expect(terminated.status).toBe(200);
    expect(disconnectHandler).toHaveBeenCalledWith('conv-2', true);

    const forbidden = await post(port, '/disconnect', 'wrong', JSON.stringify({ sessionId: 'x' }));
    expect(forbidden.status).toBe(403);
  });

  it('rejects /disconnect with a missing sessionId', async () => {
    const disconnectHandler = vi.fn();
    server = new HookServer(noopLog);
    await server.start(async () => {}, { disconnectHandler });
    const res = await post(server.getPort(), '/disconnect', server.getToken(), '{}');
    expect(res.status).toBe(400);
    expect(disconnectHandler).not.toHaveBeenCalled();
  });

  it('does not serve /disconnect when no handler is configured', async () => {
    server = new HookServer(noopLog);
    await server.start(async () => {});
    const res = await post(
      server.getPort(),
      '/disconnect',
      server.getToken(),
      JSON.stringify({ sessionId: 'conv-1' })
    );
    expect(res.status).toBe(404);
  });
});
