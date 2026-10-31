import type * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));

const servers: FakeAppServer[] = [];
const acp = { http: true };

vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        loadSession: true,
        ...(acp.http ? { mcpCapabilities: { http: true } } : {}),
      },
    }));
    server.replyAlways('authenticate', () => ({}));
    server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_model', () => ({}));
    servers.push(server);
    return server;
  },
}));

const {
  ampAcp,
  ampHome,
  ampSignedIn,
  createAmpAdapter,
} = await import('./amp-adapter');

beforeEach(() => {
  servers.length = 0;
  acp.http = true;
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function setup(resume = false, env: Record<string, string> = {}) {
  const adapter = createAmpAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env,
    mcpServers: {
      switch: { transport: 'stdio', command: 'node', args: ['server.js'], env: { MODE: 'test' } },
    },
    connectorMcpServers: [],
    ...(resume ? { resume: { nativeSessionId: 'native' } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}

it('launches amp-acp and creates a native session', async () => {
  const { server, session } = await setup();
  expect(session.sessionId).toBe('s');
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.some((m) => m.method === 'session/new')).toBe(true);
});

it('resumes previous session using session/load', async () => {
  const { server, session } = await setup(true);
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'native',
    mcpServers: [
      {
        name: 'switch',
        command: 'node',
        args: ['server.js'],
        env: [{ name: 'MODE', value: 'test' }],
      },
    ],
  });
});

it('defines launch command args for amp-acp and amp', () => {
  expect(ampAcp.launch({ binaryPath: '/path/to/amp-acp', env: {}, cwd: '/cwd' })).toEqual({
    command: '/path/to/amp-acp',
    args: [],
    env: {},
  });
  expect(ampAcp.launch({ binaryPath: 'amp-acp.exe', env: {}, cwd: '/cwd' })).toEqual({
    command: 'amp-acp.exe',
    args: [],
    env: {},
  });
  expect(ampAcp.launch({ binaryPath: '/path/to/amp', env: {}, cwd: '/cwd' })).toEqual({
    command: '/path/to/amp',
    args: ['acp'],
    env: {},
  });
});

const httpSwitch = {
  switch: { transport: 'http' as const, url: 'http://127.0.0.1:4567/mcp' },
};

it('refuses to start when HTTP MCP servers are configured without http capability', async () => {
  acp.http = false;
  const adapter = createAmpAdapter();
  await expect(
    adapter.startSession({
      sessionId: 'no-http',
      cwd: '/work',
      runtimeMode: 'approval-required',
      env: {},
      mcpServers: httpSwitch,
      connectorMcpServers: [],
    })
  ).rejects.toThrow(/does not declare MCP over HTTP/);
});

it('answers permission requests', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'write' });
  server.send({
    id: 99,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { kind: 'edit', title: 'Edit marker', toolCallId: 'edit' },
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'save', name: 'Allow for future sessions', kind: 'allow_always' },
      ],
    },
  });
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  await adapter.respondToRequest('s', request.requestId, 'accept');
  await flush();
  expect(server.received.find((m) => m.id === 99)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'once' },
  });
});

it('declines permission requests when rejected', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'write' });
  server.send({
    id: 100,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { kind: 'execute', title: 'Run command', toolCallId: 'exec' },
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
      ],
    },
  });
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  await adapter.respondToRequest('s', request.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 100)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'reject' },
  });
});

it('reads AMP_HOME from environment or defaults to ~/.amp', () => {
  expect(ampHome({ AMP_HOME: '/custom/path' })).toBe('/custom/path');
  expect(ampHome({})).toBe(join(homedir(), '.amp'));
});

it('detects sign-in via AMP_API_KEY environment variable', () => {
  expect(ampSignedIn({ AMP_API_KEY: 'test-key' })).toBe(true);
  expect(ampSignedIn({ AMP_API_KEY: '' })).toBe(false);
});

it('reports sign-in readiness through checkSignIn hook', async () => {
  const authed = await ampAcp.checkSignIn!({
    binaryPath: 'amp-acp',
    cwd: '/work',
    env: { AMP_API_KEY: 'secret' },
    handshake: async () => ({ protocolVersion: 1 }),
  });
  expect(authed).toEqual({ status: 'authenticated', message: 'Signed in.', models: [] });

  const unauthed = await ampAcp.checkSignIn!({
    binaryPath: 'amp-acp',
    cwd: '/work',
    env: {},
    handshake: async () => ({ protocolVersion: 1 }),
  });
  expect(unauthed.status).toBe('unauthenticated');
});
