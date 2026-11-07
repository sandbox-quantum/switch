import type * as fs from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AcpSignInInput } from '../acp/hooks';
import type { AcpInitializeResult } from '../acp/protocol';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import { DROID_LOGIN, createDroidAdapter, droidAcp } from './droid-acp';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));

const servers: FakeAppServer[] = [];
const lastSpawnArgs: { command?: string; args?: string[]; env?: Record<string, string> } = {};

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: { env?: Record<string, string> } = {}) => {
    lastSpawnArgs.command = command;
    lastSpawnArgs.args = args;
    lastSpawnArgs.env = options.env;

    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        sessionCapabilities: { resume: {} },
        mcpCapabilities: { http: true },
      },
    }));
    server.replyAlways('authenticate', () => ({}));
    server.replyAlways('session/new', () => ({
      sessionId: 'native-droid',
      configOptions: [
        {
          id: 'model',
          type: 'select',
          options: [{ value: 'droid-default', name: 'Default Model' }],
        },
      ],
    }));
    server.replyAlways('session/resume', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));

beforeEach(() => {
  servers.length = 0;
  lastSpawnArgs.command = undefined;
  lastSpawnArgs.args = undefined;
  lastSpawnArgs.env = undefined;
});

afterEach(() => {
  for (const server of servers) server.kill();
});

async function setup(resume = false, env: Record<string, string> = {}) {
  const adapter = createDroidAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's1',
    cwd: '/workspace',
    runtimeMode: 'approval-required',
    env,
    mcpServers: {
      switch: { transport: 'stdio', command: 'node', args: ['server.js'], env: { MODE: 'test' } },
    },
    connectorMcpServers: [],
    ...(resume ? { resume: { nativeSessionId: 'native-droid' } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}

it('launches droid exec with --output-format acp', async () => {
  await setup();
  expect(lastSpawnArgs.command).toBe('droid');
  expect(lastSpawnArgs.args).toEqual(['exec', '--output-format', 'acp']);
});

it('maps runtime modes to Droid session modes', () => {
  expect(droidAcp.sessionMode?.('full-access', undefined)).toBe('high');
  expect(droidAcp.sessionMode?.('auto-accept-edits', undefined)).toBe('medium');
  expect(droidAcp.sessionMode?.('auto', undefined)).toBe('medium');
  expect(droidAcp.sessionMode?.('approval-required', undefined)).toBe('low');
});

function mockSignInInput(
  handshake: () => Promise<AcpInitializeResult>,
  env: Record<string, string> = {}
): AcpSignInInput {
  return {
    binaryPath: 'droid',
    cwd: '/workspace',
    env,
    handshake,
    request: async () => ({}) as any,
  };
}

it('signs in with API key if FACTORY_API_KEY or DROID_API_KEY is present', async () => {
  const checkSignIn = droidAcp.checkSignIn!;
  const result1 = await checkSignIn(
    mockSignInInput(async () => ({ protocolVersion: 1 }), {
      FACTORY_API_KEY: 'test-factory-key',
    })
  );
  expect(result1.status).toBe('authenticated');
  expect(result1.message).toContain('Factory API key');

  const result2 = await checkSignIn(
    mockSignInInput(async () => ({ protocolVersion: 1 }), {
      DROID_API_KEY: 'test-droid-key',
    })
  );
  expect(result2.status).toBe('authenticated');
  expect(result2.message).toContain('Factory API key');
});

it('signs in without key if ACP handshake authMethods is empty', async () => {
  const checkSignIn = droidAcp.checkSignIn!;
  const result = await checkSignIn(
    mockSignInInput(async () => ({ protocolVersion: 1, authMethods: [] }))
  );
  expect(result.status).toBe('authenticated');
  expect(result.message).toContain('Signed in to Factory Droid');
});

it('reports unauthenticated if ACP handshake requests authMethods or throws auth error', async () => {
  const checkSignIn = droidAcp.checkSignIn!;
  const result1 = await checkSignIn(
    mockSignInInput(async () => ({
      protocolVersion: 1,
      authMethods: [{ id: 'oauth', name: 'OAuth' }],
    }))
  );
  expect(result1.status).toBe('unauthenticated');
  expect(result1.message).toContain(DROID_LOGIN);

  const result2 = await checkSignIn(
    mockSignInInput(async () => {
      throw new Error('Sign in required to proceed');
    })
  );
  expect(result2.status).toBe('unauthenticated');
  expect(result2.message).toContain(DROID_LOGIN);
});

it('registers session MCP servers and resumes native session', async () => {
  const { server, session } = await setup(true);
  expect(session.nativeSessionId).toBe('native-droid');
  expect(server.received.find((m) => m.method === 'session/resume')?.params).toMatchObject({
    sessionId: 'native-droid',
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

const flush = () => new Promise((resolve) => setImmediate(resolve));

it('handles turn execution, tool approval, and interrupt', async () => {
  const { adapter, events, server } = await setup();
  const update = (sessionId: string, u: Record<string, unknown>) =>
    server.notify('session/update', { sessionId, update: u });

  await adapter.sendTurn({ sessionId: 's1', turnId: 't1', text: 'run command' });

  update('native-droid', {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'I will run it.' },
  });

  update('native-droid', {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Run bash',
    kind: 'execute',
    status: 'in_progress',
  });

  update('native-droid', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'Done' } }],
  });

  expect(events.find((e) => e.type === 'item.completed' && e.item.id === 'call-1')).toMatchObject({
    item: {
      id: 'call-1',
      title: 'Run bash',
      status: 'completed',
    },
  });

  // Permission request and approval
  server.send({
    id: 99,
    method: 'session/request_permission',
    params: {
      sessionId: 'native-droid',
      toolCall: { kind: 'execute', title: 'Run bash', toolCallId: 'call-1' },
      options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
    },
  });
  const request = events.find((e) => e.type === 'request.opened');
  expect(request).toBeDefined();
  if (request && request.type === 'request.opened') {
    await adapter.respondToRequest('s1', request.requestId, 'accept');
    await flush();
    expect(server.received.find((m) => m.id === 99)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' },
    });
  }

  // Simulate interrupt
  await adapter.interruptTurn('s1');
  await flush();
  expect(server.received.some((m) => m.method === 'session/cancel')).toBe(true);
});

it('identifies registered MCP servers via mcpServerOf hook', () => {
  const mcpServerOf = droidAcp.mcpServerOf!;
  expect(
    mcpServerOf({
      toolCallId: '1',
      title: 'echo',
      _meta: { server: 'echo-server' },
    })
  ).toBe('echo-server');

  expect(
    mcpServerOf({
      toolCallId: '2',
      title: 'echo',
      _meta: { mcp: { server: 'nested-server' } },
    })
  ).toBe('nested-server');

  expect(
    mcpServerOf({
      toolCallId: '3',
      title: 'echo',
      rawInput: { providerIdentifier: 'raw-server' },
    })
  ).toBe('raw-server');

  expect(
    mcpServerOf({
      toolCallId: '4',
      title: 'echo',
      rawInput: { server: 'fallback-server' },
    })
  ).toBe('fallback-server');

  expect(
    mcpServerOf({
      toolCallId: '5',
      title: 'bash',
    })
  ).toBeUndefined();
});
