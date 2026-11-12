import type * as fs from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import type { McpServerSpec, RuntimeMode } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
/** What the fake agent's `_auth/status` answers, and the modes its sessions offer. */
const vibe = { authenticated: true, modes: [] as string[] };
// What vibe-acp 3.1.0 offers with smart-approve rolled out to the account.
const VIBE_MODES = ['ask', 'accept-edits', 'smart-approve', 'auto-approve'];
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { audio: false, embeddedContext: true, image: true },
        sessionCapabilities: { close: {}, list: {}, fork: {} },
      },
      authMethods: [{ id: 'browser-auth', name: 'Sign in through Mistral AI Studio' }],
    }));
    server.replyAlways('_auth/status', () => ({ authenticated: vibe.authenticated }));
    server.replyAlways('session/new', () => ({
      sessionId: 'native',
      modes: {
        currentModeId: 'accept-edits',
        availableModes: vibe.modes.map((id) => ({ id })),
      },
    }));
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createMistralVibeAdapter, mistralVibeAcp, mistralVibeSessionMode } =
  await import('./mistral-vibe-acp');
beforeEach(() => {
  servers.length = 0;
  vibe.authenticated = true;
  vibe.modes = VIBE_MODES;
});
afterEach(() => {
  for (const server of servers) server.kill();
});
const httpSwitch: Record<string, McpServerSpec> = {
  switch: {
    transport: 'http',
    url: 'http://127.0.0.1:4567/mcp',
    headers: { Authorization: 'Bearer per-session' },
  },
};
const options = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Allow for remainder of this session', kind: 'allow_always' },
  { optionId: 'allow_always_permanent', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
];
async function setup({
  mcpServers = {},
  connectorMcpServers = [],
  runtimeMode = 'approval-required',
}: {
  mcpServers?: Record<string, McpServerSpec>;
  connectorMcpServers?: string[];
  runtimeMode?: RuntimeMode;
} = {}) {
  const adapter = createMistralVibeAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode,
    env: {},
    mcpServers,
    connectorMcpServers,
  });
  const server = servers.at(-1)!;
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  const toolCall = (toolCallId: string, update: Record<string, unknown>) =>
    server.notify('session/update', {
      sessionId: 'native',
      update: { sessionUpdate: 'tool_call', toolCallId, status: 'pending', ...update },
    });
  const askPermission = (id: number, toolCallId: string) =>
    server.send({
      id,
      method: 'session/request_permission',
      params: { sessionId: 'native', toolCall: { toolCallId }, options },
    });
  return { adapter, events, server, toolCall, askPermission };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const offering = (...ids: string[]) => ({ availableModes: ids.map((id) => ({ id })) });

it("puts auto mode in Vibe's smart-approve where the session offers it, else accept-edits", () => {
  const all = offering(...VIBE_MODES);
  expect(mistralVibeSessionMode('approval-required', all)).toBe('ask');
  expect(mistralVibeSessionMode('auto-accept-edits', all)).toBe('accept-edits');
  expect(mistralVibeSessionMode('auto', all)).toBe('smart-approve');
  expect(mistralVibeSessionMode('full-access', all)).toBe('auto-approve');
  // smart-approve is offered only where Vibe has rolled it out.
  expect(mistralVibeSessionMode('auto', offering('ask', 'accept-edits', 'auto-approve'))).toBe(
    'accept-edits'
  );
  expect(mistralVibeSessionMode('auto', offering('ask'))).toBe('ask');
  // The adapter approves every request a full-access session receives.
  expect(mistralVibeSessionMode('full-access', offering('ask'))).toBeUndefined();
});

it('refuses a session that has to ask when Vibe offers no mode that asks', async () => {
  expect(() => mistralVibeSessionMode('approval-required', undefined)).toThrow(
    'offered none of the modes this session needs (ask)'
  );
  vibe.modes = ['accept-edits', 'auto-approve'];
  await expect(setup()).rejects.toThrow('could not be made to ask before running tools');
  expect(servers[0]?.received.map((m) => m.method)).not.toContain('session/set_mode');
  await expect(setup({ runtimeMode: 'auto' })).resolves.toBeDefined();
  expect(servers[1]?.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
    sessionId: 'native',
    modeId: 'accept-edits',
  });
});

it('answers sign-in from _auth/status, never from authMethods or authenticate', async () => {
  const input = { binaryPath: 'vibe-acp', cwd: '/work', env: {} };
  expect((await checkAcpSignIn(mistralVibeAcp, input)).status).toBe('authenticated');
  vibe.authenticated = false;
  const signedOut = await checkAcpSignIn(mistralVibeAcp, input);
  expect(signedOut.status).toBe('unauthenticated');
  expect(signedOut.message).toContain('vibe-acp --setup');
  for (const server of servers)
    expect(server.received.map((m) => m.method)).toEqual(['initialize', '_auth/status']);
});

it('launches without the keyring bus, which sessions are never given', async () => {
  const launch = await mistralVibeAcp.launch({
    binaryPath: 'vibe-acp',
    cwd: '/work',
    env: { PATH: '/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
  });
  expect(launch.env).toEqual({ PATH: '/usr/bin' });
});

it('registers HTTP MCP servers, which vibe-acp takes without declaring', async () => {
  const { server } = await setup({ mcpServers: httpSwitch });
  expect(server.received.slice(0, 3).map((m) => m.method)).toEqual([
    'initialize',
    'session/new',
    'session/set_mode',
  ]);
  expect(server.received[1]?.params).toMatchObject({
    mcpServers: [
      {
        name: 'switch',
        type: 'http',
        url: 'http://127.0.0.1:4567/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer per-session' }],
      },
    ],
  });
  expect(server.received[2]?.params).toEqual({ sessionId: 'native', modeId: 'ask' });
});

it('titles a permission request from its announced call and offers no permanent grant', async () => {
  const { events, toolCall, askPermission } = await setup();
  toolCall('shell', { title: 'echo hi', kind: 'execute', _meta: { tool_name: 'bash' } });
  askPermission(90, 'shell');
  await flush();
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  expect(request).toMatchObject({ requestType: 'command_execution_approval', title: 'echo hi' });
  expect(request.options.map((o) => o.label)).toEqual([
    'Allow once',
    'Allow for remainder of this session',
    'Deny',
    'Cancel',
  ]);
});

it("allows a registered server's MCP tools once, though the request names only the call or the tool", async () => {
  const { events, server, toolCall, askPermission } = await setup({ mcpServers: httpSwitch });
  toolCall('rooms', { kind: 'other', _meta: { tool_name: 'mcp_switch.list_rooms' } });
  askPermission(91, 'rooms');
  askPermission(93, 'mcp_switch.list_rooms');
  await flush();
  for (const id of [91, 93])
    expect(server.received.find((m) => m.id === id)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
  toolCall('other', { kind: 'other', _meta: { tool_name: 'mcp_other.list_rooms' } });
  askPermission(92, 'other');
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(1);
});

it("maps Vibe's normalised MCP alias back to the one registered server it names", async () => {
  const names = new Set(['switch', 'google-workspace', 'a-b', 'a.b']);
  const serverOf = (tool_name: string) =>
    mistralVibeAcp.mcpServerOf?.({ toolCallId: 'call', _meta: { tool_name } }, names);
  expect(serverOf('mcp_switch.list_rooms')).toBe('switch');
  expect(serverOf('mcp_google_workspace.search_drive')).toBe('google-workspace');
  // `a-b` and `a.b` share an alias, which Vibe then gives neither of them.
  expect(serverOf('mcp_a_b.read')).toBeUndefined();
  expect(serverOf('mcp_a_b_5d41402a.read')).toBeUndefined();
  expect(serverOf('mcp_other.read')).toBeUndefined();
  expect(serverOf('bash')).toBeUndefined();

  const { events, toolCall, askPermission } = await setup({
    mcpServers: { ...httpSwitch, 'google-workspace': httpSwitch.switch! },
    connectorMcpServers: ['google-workspace'],
  });
  toolCall('drive', { kind: 'other', _meta: { tool_name: 'mcp_google_workspace.search_drive' } });
  askPermission(94, 'drive');
  await flush();
  expect(events.find((e) => e.type === 'item.started')).toMatchObject({
    item: { id: 'drive', type: 'mcp_tool_call' },
  });
  expect(events.find((e) => e.type === 'request.opened')).toMatchObject({
    requestType: 'mcp_tool_approval',
    connector: 'google-workspace',
  });
});

// What vibe-acp 3.1.0 sends for its ask_user_question tool (`_build_elicitation_schema`).
const vibeQuestion = {
  sessionId: 'native',
  toolCallId: 'call_7',
  mode: 'form',
  message: 'User input required',
  requestedSchema: {
    type: 'object',
    properties: {
      q0: {
        type: 'string',
        title: 'Color',
        description: 'Which color?',
        oneOf: ['red', 'green', 'blue'].map((label) => ({ const: label, title: label })),
      },
      q1: {
        type: 'array',
        title: 'Sizes',
        description: 'Which sizes?',
        items: { anyOf: ['S', 'M'].map((label) => ({ const: label, title: label })) },
      },
    },
    required: ['q0', 'q1'],
  },
};

it('announces form elicitation and asks ask_user_question through it', async () => {
  const { adapter, events, server } = await setup();
  expect(server.received[0]?.params).toMatchObject({
    clientCapabilities: { elicitation: { form: {} } },
  });
  server.send({ id: 95, method: 'elicitation/create', params: vibeQuestion });
  await flush();
  const event = events.find((e) => e.type === 'user-input.requested');
  if (!event || event.type !== 'user-input.requested') throw new Error('missing question');
  expect(event.questions).toEqual([
    {
      id: 'q0',
      header: 'Color',
      question: 'Which color?',
      options: ['red', 'green', 'blue'].map((label) => ({ value: label, label })),
      multiSelect: false,
      allowCustomAnswer: false,
    },
    {
      id: 'q1',
      header: 'Sizes',
      question: 'Which sizes?',
      options: ['S', 'M'].map((label) => ({ value: label, label })),
      multiSelect: true,
      allowCustomAnswer: false,
    },
  ]);
  await adapter.respondToUserInput('s', event.requestId, { q0: 'green', q1: ['S', 'M'] });
  await flush();
  expect(server.received.find((m) => m.id === 95)?.result).toEqual({
    action: 'accept',
    content: { q0: 'green', q1: ['S', 'M'] },
  });
});

it('types a subagent effect as a subagent', async () => {
  const { events, toolCall } = await setup();
  toolCall('task', { title: 'Explore', kind: 'think', _meta: { effect_kind: 'subagent' } });
  await flush();
  expect(events.find((e) => e.type === 'item.started')).toMatchObject({
    item: { id: 'task', type: 'subagent' },
  });
});
