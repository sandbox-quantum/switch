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
  createOpenhandsAdapter,
  openhandsAcp,
  openhandsHome,
  openhandsSignedIn,
} = await import('./openhands-adapter');

beforeEach(() => {
  servers.length = 0;
  acp.http = true;
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function setup(resume = false, env: Record<string, string> = {}) {
  const adapter = createOpenhandsAdapter();
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

it('launches openhands acp and creates a native session', async () => {
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

it('reads OPENHANDS_HOME from environment or defaults to ~/.openhands', () => {
  expect(openhandsHome({ OPENHANDS_HOME: '/custom/path' })).toBe('/custom/path');
  expect(openhandsHome({})).toBe(join(homedir(), '.openhands'));
});

it('detects signed-in status via OPENHANDS_API_KEY, ALL_HANDS_API_KEY, or LLM_API_KEY', () => {
  expect(openhandsSignedIn({ OPENHANDS_API_KEY: 'oh-test-key' })).toBe(true);
  expect(openhandsSignedIn({ ALL_HANDS_API_KEY: 'all-test-key' })).toBe(true);
  expect(openhandsSignedIn({ LLM_API_KEY: 'llm-test-key' })).toBe(true);
  expect(openhandsSignedIn({ OPENHANDS_HOME: '/nonexistent/path/never/exists' })).toBe(false);
});

it('checks sign-in readiness returning authenticated or unauthenticated', async () => {
  const signedIn = await openhandsAcp.checkSignIn!({
    binaryPath: 'openhands',
    cwd: '/tmp',
    env: { OPENHANDS_API_KEY: 'secret-key' },
    handshake: async () => ({}),
  });
  expect(signedIn.status).toBe('authenticated');

  const signedOut = await openhandsAcp.checkSignIn!({
    binaryPath: 'openhands',
    cwd: '/tmp',
    env: { OPENHANDS_HOME: '/nonexistent/path/never/exists' },
    handshake: async () => ({}),
  });
  expect(signedOut.status).toBe('unauthenticated');
  expect(signedOut.message).toContain('openhands login');
});

it('defines launch command args and login command', () => {
  const launch = openhandsAcp.launch({
    binaryPath: '/path/to/openhands',
    cwd: '/tmp',
    env: { OPENHANDS_API_KEY: 'key' },
  });
  expect(launch).toEqual({
    command: '/path/to/openhands',
    args: ['acp'],
    env: { OPENHANDS_API_KEY: 'key' },
  });
  expect(openhandsAcp.loginCommand).toBe('openhands login');
  expect(openhandsAcp.inheritEnv).toContain('OPENHANDS_API_KEY');
});
