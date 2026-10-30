import type * as fs from 'node:fs/promises';
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

const { createGooseAdapter, gooseAcp, parseGooseInfo, GOOSE_LOGIN } =
  await import('./goose-adapter');

beforeEach(() => {
  servers.length = 0;
  acp.http = true;
});

async function setup(resume = false, env: Record<string, string> = {}) {
  const adapter = createGooseAdapter();
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

it('has the expected basic properties', () => {
  expect(gooseAcp.provider).toBe('goose');
  expect(gooseAcp.label).toBe('Goose');
  expect(gooseAcp.defaultBinary).toBe('goose');
  expect(gooseAcp.loginCommand).toBe('goose configure');
  expect(gooseAcp.inheritEnv).toEqual([
    'GOOSE_PROVIDER',
    'GOOSE_MODEL',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GROQ_API_KEY',
    'OPENROUTER_API_KEY',
    'OLLAMA_HOST',
  ]);
  expect(gooseAcp.promptCapabilities?.image).toBe(true);
});

it('launches goose with acp subcommand', () => {
  const launch = gooseAcp.launch({
    binaryPath: 'goose',
    cwd: '/work',
    env: { TEST_VAR: '1' },
  });
  expect(launch).toEqual({
    command: 'goose',
    args: ['acp'],
    env: { TEST_VAR: '1' },
  });
});

it('maps runtime modes to Goose ACP modes correctly', () => {
  expect(gooseAcp.sessionMode?.('full-access')).toBe('auto');
  expect(gooseAcp.sessionMode?.('auto-accept-edits')).toBe('smart_approve');
  expect(gooseAcp.sessionMode?.('auto')).toBe('smart_approve');
  expect(gooseAcp.sessionMode?.('approval-required')).toBe('approve');
});

it('parses goose info output correctly', () => {
  expect(parseGooseInfo('No provider configured')).toEqual({
    status: 'unauthenticated',
    message: `Sign in on the execution machine with ${GOOSE_LOGIN}.`,
    models: [],
  });

  expect(parseGooseInfo('Active Provider: anthropic\nModel: claude-3-5-sonnet')).toEqual({
    status: 'authenticated',
    message: 'Configured with anthropic.',
    models: [],
  });

  expect(parseGooseInfo('[Providers Status]\n  - openai:     Enabled')).toEqual({
    status: 'authenticated',
    message: 'Configured.',
    models: [],
  });

  expect(parseGooseInfo('Active Provider: None')).toEqual({
    status: 'unauthenticated',
    message: `Sign in on the execution machine with ${GOOSE_LOGIN}.`,
    models: [],
  });
});

it('checks sign-in using GOOSE_PROVIDER environment variable when present', async () => {
  const result = await gooseAcp.checkSignIn!({
    binaryPath: 'goose',
    cwd: '/work',
    env: { GOOSE_PROVIDER: 'anthropic' },
    handshake: async () => ({}),
  });
  expect(result.status).toBe('authenticated');
  expect(result.message).toContain('GOOSE_PROVIDER');
});

it('starts a session, sends session/set_mode, and loads session on resume', async () => {
  const { server, session } = await setup(true);
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.some((m) => m.method === 'session/set_mode')).toBe(true);
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
