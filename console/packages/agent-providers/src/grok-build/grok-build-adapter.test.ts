import type * as fs from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
/** Whether the fake CLI's `authMethods` include `cached_token`, as a signed-in agent's do. */
let signedIn = false;
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: { loadSession: true },
      authMethods: signedIn
        ? [
            { id: 'cached_token', name: 'cached_token', description: 'Cached token' },
            { id: 'grok.com', name: 'Grok', description: 'Sign in with Grok' },
          ]
        : [{ id: 'grok.com', name: 'Grok', description: 'Sign in with Grok' }],
    }));
    server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { grokBuildAcp, createGrokBuildAdapter } = await import('./grok-build-adapter');
const unusedHandshake = async () => {
  throw new Error('checkSignIn must not call the given handshake');
};
const unusedRequest = async () => {
  throw new Error('checkSignIn must not call the given request');
};
const unusedConnection = () => {
  throw new Error('checkSignIn must not call the given connection');
};

beforeEach(() => {
  servers.length = 0;
  signedIn = false;
});

it('runs grok build in ACP mode with no extra flags', () => {
  expect(
    grokBuildAcp.launch({ binaryPath: '/usr/bin/grok', cwd: '/work', env: { X: '1' } })
  ).toEqual({
    command: '/usr/bin/grok',
    args: ['agent', 'stdio'],
    env: { X: '1' },
  });
});

it('defines no sessionMode: session/new advertises no modes to pin', () => {
  expect(grokBuildAcp.sessionMode).toBeUndefined();
});

it('never sends authenticate at session start', async () => {
  const adapter = createGrokBuildAdapter();
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
  });
  expect(servers.at(-1)!.received.some((m) => m.method === 'authenticate')).toBe(false);
});

it('trusts a given API key without starting a process', async () => {
  const result = await grokBuildAcp.checkSignIn!({
    binaryPath: '/usr/bin/grok',
    cwd: '/work',
    env: { XAI_API_KEY: 'xai-test' },
    handshake: unusedHandshake,
    request: unusedRequest,
    connection: unusedConnection,
  });
  expect(result.status).toBe('authenticated');
  expect(servers).toHaveLength(0);
});

it('reports signed in when the handshake lists cached_token, without calling authenticate', async () => {
  signedIn = true;
  let handshakeCalls = 0;
  const result = await grokBuildAcp.checkSignIn!({
    binaryPath: '/usr/bin/grok',
    cwd: '/work',
    env: {},
    handshake: async () => {
      handshakeCalls += 1;
      return { authMethods: [{ id: 'cached_token' }, { id: 'grok.com' }] };
    },
    request: unusedRequest,
    connection: unusedConnection,
  });
  expect(result).toEqual({ status: 'authenticated', message: 'Signed in.', models: [] });
  expect(handshakeCalls).toBe(1);
});

it('hints to sign in when the handshake lists only grok.com', async () => {
  const result = await grokBuildAcp.checkSignIn!({
    binaryPath: '/usr/bin/grok',
    cwd: '/work',
    env: {},
    handshake: async () => ({ authMethods: [{ id: 'grok.com' }] }),
    request: unusedRequest,
    connection: unusedConnection,
  });
  expect(result.status).toBe('unauthenticated');
  expect(result.message).toBe(
    'Sign in on the execution machine with grok login (or grok login --device-auth without a browser), or set XAI_API_KEY there.'
  );
});

it.each([
  ['echo__switch_echo: {"text":"PROBE_GROK_1234"}', 'echo'],
  ['google-workspace__gmail_search: {}', 'google-workspace'],
  ['search_tool: {"query":"echo tool"}', undefined],
  ['use_tool: {"tool_name":"echo__switch_echo"}', undefined],
  ['read_file: {"target_file":"a__b.ts"}', undefined],
  [undefined, undefined],
])('reads the MCP server from the tool title %s', (title, server) => {
  expect(
    grokBuildAcp.mcpServerOf!({ toolCallId: 'c', title }, new Set(['echo', 'google-workspace']))
  ).toBe(server);
});

it.each([
  [{ 'x.ai/tool': { name: 'spawn_subagent' } }, 'subagent'],
  [{ 'x.ai/tool': { name: 'use_tool' } }, undefined],
  [{ 'x.ai/tool': { name: 'read_file' } }, undefined],
  [{}, undefined],
  [undefined, undefined],
])('types a tool call by its stable x.ai/tool name, not its title %s', (meta, type) => {
  expect(
    grokBuildAcp.itemType!({ toolCallId: 'c', title: 'Read README first line', _meta: meta })
  ).toBe(type);
});
