import type * as fs from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { FakeAppServer } from '../codex/fake-app-server';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));

const servers: FakeAppServer[] = [];
let authenticated = true;
const sessionResult = {
  sessionId: 'native',
  configOptions: [
    { id: 'model', type: 'select', options: [{ value: 'codestral', name: 'Codestral' }] },
  ],
};

vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: { loadSession: true },
    }));
    server.replyAlways('_auth/status', () => ({ authenticated }));
    server.replyAlways('session/new', () => sessionResult);
    server.replyAlways('session/load', () => sessionResult);
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));

const { createMistralVibeAdapter, mistralVibeAcp } = await import('./mistral-vibe-acp');

beforeEach(() => {
  servers.length = 0;
  authenticated = true;
});

afterEach(() => {
  for (const server of servers) server.kill();
});

it('launches the native ACP executable without arguments', () => {
  const env = { MISTRAL_API_KEY: 'synthetic' };
  expect(mistralVibeAcp.launch({ binaryPath: '/bin/vibe-acp', cwd: '/work', env })).toEqual({
    command: '/bin/vibe-acp',
    args: [],
    env,
  });
});

it('detects signed-in and signed-out states without authenticating', async () => {
  const input = { binaryPath: 'vibe-acp', cwd: '/work', env: {} };
  await expect(checkAcpSignIn(mistralVibeAcp, input)).resolves.toEqual({
    status: 'authenticated',
    message: 'Signed in to Mistral Vibe.',
    models: [],
  });
  expect(servers[0]!.received.map((message) => message.method)).toEqual([
    'initialize',
    '_auth/status',
  ]);

  authenticated = false;
  await expect(checkAcpSignIn(mistralVibeAcp, input)).resolves.toEqual({
    status: 'unauthenticated',
    message: 'Sign in on the execution machine with vibe-acp --setup.',
    models: [],
  });
  expect(servers[1]!.received.some((message) => message.method === 'authenticate')).toBe(false);
});

it('maps Switch runtime modes to Vibe agent profiles', () => {
  expect(mistralVibeAcp.sessionMode?.('approval-required')).toBe('ask');
  expect(mistralVibeAcp.sessionMode?.('auto-accept-edits')).toBe('accept-edits');
  expect(mistralVibeAcp.sessionMode?.('auto')).toBe('smart-approve');
  expect(mistralVibeAcp.sessionMode?.('full-access')).toBe('auto-approve');
});

it('recognizes Vibe MCP and subagent metadata', () => {
  expect(
    mistralVibeAcp.mcpServerOf?.({
      toolCallId: 'mcp-call',
      _meta: { tool_name: 'mcp_switch.connect_to_room' },
    })
  ).toBe('switch');
  expect(
    mistralVibeAcp.mcpServerOf?.(
      { toolCallId: 'hyphenated-mcp-call', _meta: { tool_name: 'mcp_google_workspace.search' } },
      new Set(['google-workspace'])
    )
  ).toBe('google-workspace');
  expect(
    mistralVibeAcp.mcpServerOf?.(
      { toolCallId: 'ambiguous-mcp-call', _meta: { tool_name: 'mcp_google_workspace.search' } },
      new Set(['google_workspace', 'google-workspace'])
    )
  ).toBeUndefined();
  expect(
    mistralVibeAcp.mcpServerOf?.(
      { toolCallId: 'dollar-mcp-call', _meta: { tool_name: 'mcp_server$alias.search' } },
      new Set(['server$alias'])
    )
  ).toBe('server$alias');
  expect(
    mistralVibeAcp.mcpServerOf?.({
      toolCallId: 'ordinary-call',
      _meta: { tool_name: 'file_system.read_file' },
    })
  ).toBeUndefined();
  expect(
    mistralVibeAcp.itemType?.({
      toolCallId: 'subagent-call',
      _meta: { effect_kind: 'subagent' },
    })
  ).toBe('subagent');
});

it('passes Switch HTTP MCP to Vibe when its initialize omits the capability', async () => {
  const adapter = createMistralVibeAdapter();
  await adapter.startSession({
    sessionId: 'switch-session',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {
      switch: { transport: 'http', url: 'http://127.0.0.1:1234/mcp', headers: {} },
    },
    connectorMcpServers: [],
  });

  expect(
    servers.at(-1)!.received.find((message) => message.method === 'session/new')?.params
  ).toMatchObject({
    mcpServers: [{ name: 'switch', type: 'http', url: 'http://127.0.0.1:1234/mcp' }],
  });
});

it('resumes sessions and selects the requested model through ACP config', async () => {
  const adapter = createMistralVibeAdapter();
  const session = await adapter.startSession({
    sessionId: 'switch-session',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
    model: { id: 'codestral', options: {} },
    resume: { nativeSessionId: 'native' },
  });
  const server = servers.at(-1)!;

  expect(session.nativeSessionId).toBe('native');
  expect(
    server.received.find((message) => message.method === 'session/load')?.params
  ).toMatchObject({ sessionId: 'native' });
  expect(server.received.find((message) => message.method === 'session/set_mode')?.params).toEqual({
    sessionId: 'native',
    modeId: 'ask',
  });
  expect(
    server.received.find((message) => message.method === 'session/set_config_option')?.params
  ).toEqual({ sessionId: 'native', configId: 'model', value: 'codestral' });
});
