import type * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpInitializeResult } from '../acp/protocol';
import { FakeAppServer } from '../codex/fake-app-server';
import { JsonRpcError } from '../transport/stdio-json-rpc';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));

const servers: FakeAppServer[] = [];
const spawned: Array<{ command: string; args: string[] }> = [];
const acp = { signedOut: false };
const SIGNED_OUT = 'Authentication is required before this operation can be performed.';
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawned.push({ command, args });
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
      authMethods: [{ id: 'jetbrains-account', name: 'JetBrains account' }],
    }));
    server.on('message', (message: { id?: number; method?: string }) => {
      if (message.method !== 'session/new' || message.id === undefined) return;
      server.send(
        acp.signedOut
          ? { id: message.id, error: { code: -32000, message: SIGNED_OUT } }
          : { id: message.id, result: { sessionId: 'native' } }
      );
    });
    servers.push(server);
    return server;
  },
}));
const { createJunieAdapter, junieAcp } = await import('./junie-adapter');
beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
  acp.signedOut = false;
});
afterEach(() => {
  for (const server of servers) server.kill();
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

function start() {
  return createJunieAdapter().startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
  });
}

it('runs `junie --acp=true` and never authenticates, whatever methods Junie lists', async () => {
  await start();
  expect(spawned).toEqual([{ command: 'junie', args: ['--acp=true'] }]);
  expect(servers[0]!.received.map((m) => m.method)).toEqual(['initialize', 'session/new']);
});

it('reports a signed-out session start with Junie’s own refusal', async () => {
  acp.signedOut = true;
  const started = start();
  await expect(started).rejects.toThrow('Could not start Junie');
  await expect(started).rejects.toThrow(SIGNED_OUT);
});

it('queues a message sent mid-turn behind the running turn', async () => {
  const adapter = createJunieAdapter();
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
  });
  const server = servers[0]!;
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'first' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'second' });
  const prompt = await server.waitFor('session/prompt');
  expect(server.received.filter((m) => m.method === 'session/prompt')).toHaveLength(1);
  server.send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  await flush();
  expect(server.received.filter((m) => m.method === 'session/prompt')).toHaveLength(2);
  expect(junieAcp.capabilities.steering).toBe(false);
});

it('leaves Junie’s own permission setting alone and passes its API key through', () => {
  expect(junieAcp.sessionMode).toBeUndefined();
  expect(junieAcp.authMethodId).toBeUndefined();
  expect(junieAcp.inheritEnv).toEqual(['JUNIE_API_KEY']);
});

describe('checkSignIn', () => {
  const check = (request: (method: string) => Promise<unknown>) => {
    const handshake = vi.fn(async () => ({}) as AcpInitializeResult);
    const result = junieAcp.checkSignIn!({
      binaryPath: 'junie',
      cwd: '/work',
      env: {},
      handshake,
      request: request as never,
    });
    return { handshake, result };
  };

  it('is signed in when Junie lists its sessions', async () => {
    const request = vi.fn(async () => ({ sessions: [] }));
    const { handshake, result } = check(request);
    expect(await result).toMatchObject({ status: 'authenticated' });
    expect(handshake).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('session/list', {});
  });

  it('is signed out when Junie refuses the list, and says how to sign in', async () => {
    const { result } = check(async () => {
      throw new JsonRpcError(-32000, SIGNED_OUT);
    });
    expect(await result).toMatchObject({
      status: 'unauthenticated',
      message: expect.stringContaining('Sign in on the execution machine with junie.'),
    });
  });

  it('also reads the shared signed-out wording as signed out', async () => {
    const { result } = check(async () => {
      throw new JsonRpcError(-32000, 'Authentication required');
    });
    expect(await result).toMatchObject({ status: 'unauthenticated' });
  });

  it('does not call any other failure signed out', async () => {
    const { result } = check(async () => {
      throw new JsonRpcError(-32601, 'Method not found');
    });
    await expect(result).rejects.toThrow('Method not found');
  });
});
