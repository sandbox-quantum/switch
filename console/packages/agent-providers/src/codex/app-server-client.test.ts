import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAppServer } from './fake-app-server';

const servers: FakeAppServer[] = [];

vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    servers.push(server);
    return server;
  },
}));

const { AppServerClient, JsonRpcError, noopLogger } = await import('./app-server-client');

function connect(onExit: (reason: string) => void = () => {}) {
  const client = new AppServerClient({
    command: 'codex',
    args: ['app-server'],
    cwd: '/tmp',
    env: {},
    logger: noopLogger,
    onExit,
  });
  const server = servers.at(-1);
  if (!server) throw new Error('fake app-server was not spawned');
  return { client, server };
}

describe('AppServerClient', () => {
  beforeEach(() => {
    servers.length = 0;
  });
  afterEach(() => {
    for (const server of servers) server.removeAllListeners();
  });

  it('frames requests as newline-delimited JSON-RPC and resolves the matching id', async () => {
    const { client, server } = connect();
    server.reply('thread/start', { thread: { id: 'thread-1' } });
    const result = await client.request<{ thread: { id: string } }>('thread/start', { cwd: '/w' });
    expect(result.thread.id).toBe('thread-1');
    expect(server.received[0]).toMatchObject({
      id: 1,
      method: 'thread/start',
      params: { cwd: '/w' },
    });
  });

  it('rejects with a JsonRpcError carrying the server code', async () => {
    const { client, server } = connect();
    server.on('message', (message) => {
      if (message.id !== undefined) {
        server.send({ id: message.id, error: { code: -32600, message: 'no rollout found' } });
      }
    });
    await expect(client.request('thread/resume', {})).rejects.toBeInstanceOf(JsonRpcError);
  });

  it('answers a server-initiated request on the same id', async () => {
    const { client, server } = connect();
    client.onServerRequest('item/fileChange/requestApproval', async () => ({ decision: 'accept' }));
    const answer = new Promise<Record<string, unknown>>((resolve) => {
      server.on('message', (message) => {
        if (message.id === 7 && message.result) resolve(message.result as Record<string, unknown>);
      });
    });
    server.send({ id: 7, method: 'item/fileChange/requestApproval', params: { itemId: 'x' } });
    expect(await answer).toEqual({ decision: 'accept' });
  });

  it('replies with an error when no handler is registered for a server request', async () => {
    const { server } = connect();
    const reply = new Promise<{ code: number }>((resolve) => {
      server.on('message', (message) => {
        if (message.id === 3 && message.error) resolve(message.error);
      });
    });
    server.send({ id: 3, method: 'item/tool/requestUserInput', params: {} });
    expect((await reply).code).toBe(-32601);
  });

  it('routes notifications by method and ignores unparsable lines', async () => {
    const { client, server } = connect();
    const seen: unknown[] = [];
    client.onNotification('turn/started', (params) => seen.push(params));
    server.sendRaw('not json at all');
    server.notify('turn/started', { turn: { id: 't1' } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ turn: { id: 't1' } });
  });

  it('rejects everything in flight and reports the exit once', async () => {
    const exits: string[] = [];
    const { client, server } = connect((reason) => exits.push(reason));
    const inFlight = client.request('turn/start', {});
    server.emit('exit', 2, null);
    server.emit('exit', 2, null);
    await expect(inFlight).rejects.toThrow(/turn\/start/);
    expect(exits).toHaveLength(1);
    expect(client.isAlive).toBe(false);
    await expect(client.request('turn/start', {})).rejects.toThrow(/no longer|gone/);
  });

  it('keeps a tail of stderr for failure messages', async () => {
    const { client, server } = connect();
    server.stderr.write('ERROR codex exploded\n');
    await vi.waitFor(() => expect(client.stderr).toContain('codex exploded'));
  });
});
