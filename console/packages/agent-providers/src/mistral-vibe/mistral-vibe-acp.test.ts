import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import type { RuntimeMode } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import { createMistralVibeAdapter, mistralVibeAcp } from './mistral-vibe-acp';

const fixture = vi.hoisted((): { authenticated: unknown } => ({ authenticated: false }));
const servers: FakeAppServer[] = [];
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  realpath: async (path: string) => path,
}));
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({ agentCapabilities: { loadSession: true } }));
    server.replyAlways('_auth/status', () => ({ authenticated: fixture.authenticated }));
    for (const method of ['session/new', 'session/load'])
      server.replyAlways(method, () => ({
        sessionId: 'native',
        modes: {
          availableModes: ['ask', 'accept-edits', 'smart-approve', 'auto-approve'].map((id) => ({
            id,
          })),
          currentModeId: 'auto-approve',
        },
        configOptions: [
          {
            id: 'model',
            type: 'select',
            currentValue: 'default',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'other', name: 'Other' },
            ],
          },
        ],
      }));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    servers.push(server);
    return server;
  },
}));
beforeEach(() => {
  fixture.authenticated = false;
});
afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
});

it.each([
  [true, 'authenticated'],
  [false, 'unauthenticated'],
  ['true', 'unknown'],
])(
  'reads authentication status %s without invoking authenticate',
  async (authenticated, status) => {
    fixture.authenticated = authenticated;
    const result = await checkAcpSignIn(mistralVibeAcp, {
      binaryPath: 'vibe-acp',
      cwd: '/work',
      env: {},
    });
    expect(result.status).toBe(status);
    expect(servers.at(-1)!.received.map((request) => request.method)).toEqual([
      'initialize',
      '_auth/status',
    ]);
  }
);

it('uses the supplied executable and environment without a desktop-only keyring', async () => {
  const env = { VIBE_HOME: '/vibe', MISTRAL_API_KEY: 'test-key', DBUS_SESSION_BUS_ADDRESS: 'bus' };
  expect(await mistralVibeAcp.launch({ binaryPath: '/tools/vibe-acp', cwd: '/work', env })).toEqual(
    {
      command: '/tools/vibe-acp',
      args: [],
      env: { VIBE_HOME: '/vibe', MISTRAL_API_KEY: 'test-key' },
    }
  );
  expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('bus');
});

it.each<[RuntimeMode, string]>([
  ['approval-required', 'ask'],
  ['auto-accept-edits', 'accept-edits'],
  ['auto', 'smart-approve'],
  ['full-access', 'auto-approve'],
])('selects %s only when its native mode is advertised', (mode, native) => {
  expect(mistralVibeAcp.sessionMode!(mode, { availableModes: [{ id: native }] })).toBe(native);
  expect(() => mistralVibeAcp.sessionMode!(mode, { availableModes: [{ id: 'custom' }] })).toThrow(
    `required for ${mode}`
  );
  expect(() => mistralVibeAcp.sessionMode!(mode, undefined)).toThrow(`required for ${mode}`);
});

it('maps normalized MCP names only when attribution is unambiguous', () => {
  const call = { toolCallId: 'call', _meta: { tool_name: 'mcp_google_workspace.search' } };
  expect(mistralVibeAcp.mcpServerOf!(call, new Set(['google-workspace']))).toBe('google-workspace');
  expect(
    mistralVibeAcp.mcpServerOf!(call, new Set(['google-workspace', 'google_workspace']))
  ).toBeUndefined();
  expect(mistralVibeAcp.mcpServerOf!(call, new Set(['switch']))).toBeUndefined();
  expect(
    mistralVibeAcp.mcpServerOf!(
      { toolCallId: 'mcp_google_workspace.search' },
      new Set(['google-workspace'])
    )
  ).toBe('google-workspace');
});

it('loads a conversation, selects a non-default model and attributes a sparse connector approval', async () => {
  const adapter = createMistralVibeAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  try {
    await adapter.startSession({
      sessionId: 's',
      cwd: '/work',
      env: {},
      runtimeMode: 'approval-required',
      model: { id: 'other' },
      resume: { nativeSessionId: 'native' },
      mcpServers: { 'google-workspace': { transport: 'http', url: 'http://localhost/mcp' } },
      connectorMcpServers: ['google-workspace'],
    });
    const server = servers.at(-1)!;
    expect(
      server.received.find((request) => request.method === 'session/load')?.params
    ).toMatchObject({
      sessionId: 'native',
      mcpServers: [{ name: 'google-workspace', type: 'http' }],
    });
    expect(
      server.received.find((request) => request.method === 'session/set_mode')?.params
    ).toMatchObject({ modeId: 'ask' });
    expect(
      server.received.find((request) => request.method === 'session/set_config_option')?.params
    ).toMatchObject({ configId: 'model', value: 'other' });
    await expect(adapter.setModel('s', { id: 'missing' })).rejects.toThrow('Unavailable model');
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'search' });
    server.send({
      method: 'session/update',
      params: {
        sessionId: 'native',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call',
          title: 'Search',
          kind: 'other',
          _meta: { tool_name: 'mcp_google_workspace.search' },
        },
      },
    });
    server.send({
      id: 90,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId: 'call' },
        options: [
          { optionId: 'once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'allow_always_permanent', name: 'Always allow', kind: 'allow_always' },
        ],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const request = events.find((event) => event.type === 'request.opened');
    expect(request).toMatchObject({
      requestType: 'mcp_tool_approval',
      connector: 'google-workspace',
    });
    if (request?.type !== 'request.opened') throw new Error('No approval');
    expect(request.options.map((option) => option.decision)).toEqual(['accept', 'cancel']);
    await adapter.respondToRequest('s', request.requestId, 'decline');
    await vi.waitFor(() => {
      expect(server.received.find((reply) => reply.id === 90)?.result).toEqual({
        outcome: { outcome: 'cancelled' },
      });
    });
  } finally {
    await adapter.stopAll();
  }
});
