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
  createMistralVibeAdapter,
  mistralVibeAcp,
  vibeHome,
  vibeSignedIn,
} = await import('./mistral-vibe-adapter');

beforeEach(() => {
  servers.length = 0;
  acp.http = true;
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function setup(resume = false, env: Record<string, string> = {}) {
  const adapter = createMistralVibeAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/tmp',
    runtimeMode: 'approval-required',
    env,
    mcpServers: {},
    connectorMcpServers: [],
    ...(resume ? { resume: { nativeSessionId: 'acp:native' } } : {}),
  });
  await flush();
  const server = servers[servers.length - 1]!;
  return { adapter, events, server };
}

it('connects to ACP server and starts a new session', async () => {
  const { events, server } = await setup();
  expect(server.received.map((m) => m.method)).toContain('initialize');
  expect(server.received.map((m) => m.method)).toContain('session/new');
  expect(events.some((e) => e.type === 'session.started')).toBe(true);
});

it('resumes an existing session when resume option is true', async () => {
  const { server } = await setup(true);
  expect(server.received.map((m) => m.method)).toContain('session/load');
});

it('registers MCP servers on session start', async () => {
  const adapter = createMistralVibeAdapter();
  await adapter.startSession({
    sessionId: 's',
    cwd: '/tmp',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {
      tools: {
        transport: 'http',
        url: 'http://localhost:3000',
      },
    },
    connectorMcpServers: [],
  });
  await flush();
  const server = servers[servers.length - 1]!;
  expect(server.received.find((m) => m.method === 'session/new')?.params).toMatchObject({
    mcpServers: [{ name: 'tools', type: 'http', url: 'http://localhost:3000' }],
  });
});

it('dispatches approval requests and replies with accepted option', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'write' });
  server.send({
    id: 99,
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

it('reads VIBE_HOME from environment or defaults to ~/.vibe', () => {
  expect(vibeHome({ VIBE_HOME: '/custom/vibe' })).toBe('/custom/vibe');
  expect(vibeHome({})).toBe(join(homedir(), '.vibe'));
});

it('detects signed-in status via MISTRAL_API_KEY', () => {
  expect(vibeSignedIn({ MISTRAL_API_KEY: 'test-mistral-key' })).toBe(true);
  expect(vibeSignedIn({ VIBE_HOME: '/nonexistent/path/never/exists' })).toBe(false);
});

it('checks sign-in readiness returning authenticated or unauthenticated', async () => {
  const signedIn = await mistralVibeAcp.checkSignIn!({
    binaryPath: 'vibe-acp',
    cwd: '/tmp',
    env: { MISTRAL_API_KEY: 'secret-key' },
    handshake: async () => ({}),
  });
  expect(signedIn.status).toBe('authenticated');

  const signedOut = await mistralVibeAcp.checkSignIn!({
    binaryPath: 'vibe-acp',
    cwd: '/tmp',
    env: { VIBE_HOME: '/nonexistent/path/never/exists' },
    handshake: async () => ({}),
  });
  expect(signedOut.status).toBe('unauthenticated');
  expect(signedOut.message).toContain('vibe --setup');
});

it('defines launch command args for vibe-acp and vibe', () => {
  const launchVibeAcp = mistralVibeAcp.launch({
    binaryPath: '/path/to/vibe-acp',
    cwd: '/tmp',
    env: { MISTRAL_API_KEY: 'key' },
  });
  expect(launchVibeAcp).toEqual({
    command: '/path/to/vibe-acp',
    args: [],
    env: { MISTRAL_API_KEY: 'key' },
  });

  const launchVibe = mistralVibeAcp.launch({
    binaryPath: '/path/to/vibe',
    cwd: '/tmp',
    env: { MISTRAL_API_KEY: 'key' },
  });
  expect(launchVibe).toEqual({
    command: '/path/to/vibe',
    args: ['acp'],
    env: { MISTRAL_API_KEY: 'key' },
  });

  expect(mistralVibeAcp.loginCommand).toBe('vibe --setup');
  expect(mistralVibeAcp.inheritEnv).toContain('MISTRAL_API_KEY');
});
