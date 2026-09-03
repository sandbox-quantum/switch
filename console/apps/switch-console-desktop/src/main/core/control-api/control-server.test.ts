import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlServer, sendJson } from './control-server';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => resolve({ status: res.statusCode!, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('ControlServer', () => {
  let server: ControlServer;

  beforeEach(async () => {
    server = new ControlServer(silentLogger);
  });

  afterEach(() => {
    server.stop();
  });

  it('rejects requests without a token', async () => {
    server.route('GET', '/test', (_req, res) => {
      sendJson(res, 200, { ok: true });
    });
    await server.start();
    const result = await request(server.getPort(), 'GET', '/test');
    expect(result.status).toBe(403);
  });

  it('rejects requests with a wrong token', async () => {
    server.route('GET', '/test', (_req, res) => {
      sendJson(res, 200, { ok: true });
    });
    await server.start();
    const result = await request(server.getPort(), 'GET', '/test', {
      'x-switch-control-token': 'wrong-token',
    });
    expect(result.status).toBe(403);
  });

  it('accepts requests with the correct token', async () => {
    server.route('GET', '/test', (_req, res) => {
      sendJson(res, 200, { ok: true });
    });
    await server.start();
    const result = await request(server.getPort(), 'GET', '/test', {
      'x-switch-control-token': server.getToken(),
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
  });

  it('returns 404 for unregistered routes', async () => {
    await server.start();
    const result = await request(server.getPort(), 'GET', '/nonexistent', {
      'x-switch-control-token': server.getToken(),
    });
    expect(result.status).toBe(404);
  });

  it('matches routes with path parameters', async () => {
    let captured: Record<string, string> = {};
    server.route('GET', '/items/:id', (_req, res, params) => {
      captured = params;
      sendJson(res, 200, { id: params['id'] });
    });
    await server.start();
    const result = await request(server.getPort(), 'GET', '/items/abc-123', {
      'x-switch-control-token': server.getToken(),
    });
    expect(result.status).toBe(200);
    expect(captured['id']).toBe('abc-123');
    expect(JSON.parse(result.body)).toEqual({ id: 'abc-123' });
  });

  it('matches routes with multiple path parameters', async () => {
    let captured: Record<string, string> = {};
    server.route('DELETE', '/agents/:agentId/sessions/:sessionId', (_req, res, params) => {
      captured = params;
      sendJson(res, 200, { ok: true });
    });
    await server.start();
    const result = await request(server.getPort(), 'DELETE', '/agents/agent-1/sessions/session-2', {
      'x-switch-control-token': server.getToken(),
    });
    expect(result.status).toBe(200);
    expect(captured['agentId']).toBe('agent-1');
    expect(captured['sessionId']).toBe('session-2');
  });

  it('distinguishes methods on the same path', async () => {
    server.route('GET', '/items', (_req, res) => {
      sendJson(res, 200, { action: 'list' });
    });
    server.route('POST', '/items', (_req, res) => {
      sendJson(res, 201, { action: 'create' });
    });
    await server.start();
    const token = server.getToken();

    const getResult = await request(server.getPort(), 'GET', '/items', {
      'x-switch-control-token': token,
    });
    expect(JSON.parse(getResult.body)).toEqual({ action: 'list' });

    const postResult = await request(server.getPort(), 'POST', '/items', {
      'x-switch-control-token': token,
    });
    expect(postResult.status).toBe(201);
    expect(JSON.parse(postResult.body)).toEqual({ action: 'create' });
  });

  it('is reachable on 127.0.0.1', async () => {
    server.route('GET', '/ping', (_req, res) => {
      sendJson(res, 200, { pong: true });
    });
    await server.start();
    const result = await request(server.getPort(), 'GET', '/ping', {
      'x-switch-control-token': server.getToken(),
    });
    expect(result.status).toBe(200);
  });

  it('generates a valid UUID token', async () => {
    await server.start();
    const token = server.getToken();
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('returns a non-zero port after start', async () => {
    await server.start();
    expect(server.getPort()).toBeGreaterThan(0);
  });

  it('resets port after stop', async () => {
    await server.start();
    expect(server.getPort()).toBeGreaterThan(0);
    server.stop();
    expect(server.getPort()).toBe(0);
  });
});
