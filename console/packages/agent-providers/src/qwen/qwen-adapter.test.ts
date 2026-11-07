import type * as fs from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));

const servers: FakeAppServer[] = [];
/** What the fake agent answers: its sign-in, and the modes `session/new` lists. */
const qwen = { signedIn: true, modes: ['plan', 'default', 'auto-edit', 'auto', 'yolo'] };
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true } },
      authMethods: [{ id: 'openai', name: 'Use OpenAI API key' }],
    }));
    server.on('message', (message) => {
      if (message.method !== 'session/new' || message.id === undefined) return;
      server.send(
        qwen.signedIn
          ? {
              id: message.id,
              result: {
                sessionId: 'native',
                modes: { currentModeId: 'auto', availableModes: qwen.modes.map((id) => ({ id })) },
              },
            }
          : {
              id: message.id,
              error: {
                code: -32000,
                message:
                  'Authentication required: Use /auth to sign in or configure a model first.',
              },
            }
      );
    });
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { checkAcpSignIn } = await import('../acp/acp-adapter');
const { createQwenAdapter, qwenAcp } = await import('./qwen-adapter');
beforeEach(() => {
  servers.length = 0;
  qwen.signedIn = true;
  qwen.modes = ['plan', 'default', 'auto-edit', 'auto', 'yolo'];
});
async function setup(
  runtimeMode: 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'
) {
  const adapter = createQwenAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode,
    env: {},
    mcpServers: { switch: { transport: 'stdio', command: 'node', args: ['server.js'], env: {} } },
    connectorMcpServers: [],
  });
  const server = servers.at(-1)!;
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  return { adapter, events, server };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const shellRequest = (id: number, optionIds: string[]) => ({
  id,
  method: 'session/request_permission',
  params: {
    sessionId: 'native',
    toolCall: {
      toolCallId: 'call_1__qwen_dup_2',
      status: 'pending',
      title: 'rm -f /work/scratch.txt (d)',
      kind: 'execute',
      rawInput: { command: 'rm -f /work/scratch.txt' },
      _meta: { toolName: 'run_shell_command' },
    },
    options: [
      {
        optionId: 'proceed_always_project',
        name: 'Always Allow in project: rm *',
        kind: 'allow_always',
      },
      {
        optionId: 'proceed_always_user',
        name: 'Always Allow for user: rm *',
        kind: 'allow_always',
      },
      { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
      {
        optionId: 'proceed_once_and_switch_to_default',
        name: 'Switch to Default Mode and allow once (recommended)',
        kind: 'allow_once',
      },
      { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
    ].filter((option) => optionIds.includes(option.optionId)),
  },
});

it('runs `qwen --acp`', () => {
  expect(qwenAcp.launch({ binaryPath: '/bin/qwen', cwd: '/work', env: { A: 'b' } })).toEqual({
    command: '/bin/qwen',
    args: ['--acp'],
    env: { A: 'b' },
  });
});

it('puts every session in a mode it asks in, never the auto mode it starts in', async () => {
  for (const [runtimeMode, modeId] of [
    ['approval-required', 'default'],
    ['auto-accept-edits', 'auto-edit'],
    ['auto', 'auto'],
    ['full-access', 'yolo'],
  ] as const) {
    const { server } = await setup(runtimeMode);
    expect(server.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
      sessionId: 'native',
      modeId,
    });
  }
});

it('refuses a session whose mode this Qwen Code does not offer', async () => {
  qwen.modes = ['plan', 'auto', 'yolo'];
  await expect(setup('approval-required')).rejects.toThrow('does not offer its default mode');
  expect(() => qwenAcp.sessionMode?.('full-access', undefined)).toThrow('yolo mode');
});

it('offers Allow and Reject, and never the permanent rules or the mode switch', async () => {
  const { events, server } = await setup('approval-required');
  server.send(
    shellRequest(70, [
      'proceed_always_project',
      'proceed_always_user',
      'proceed_once',
      'proceed_once_and_switch_to_default',
      'cancel',
    ])
  );
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  expect(request.requestType).toBe('command_execution_approval');
  expect(request.options).toEqual([
    { decision: 'accept', label: 'Allow' },
    { decision: 'decline', label: 'Reject' },
    { decision: 'cancel', label: 'Cancel' },
  ]);
});

it('answers with Qwen’s own option ids', async () => {
  const { adapter, events, server } = await setup('approval-required');
  server.send(shellRequest(71, ['proceed_always_project', 'proceed_once', 'cancel']));
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  await adapter.respondToRequest('s', request.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 71)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'cancel' },
  });
});

it('keeps Allow All Edits, which lasts for the session only', async () => {
  const { events, server } = await setup('approval-required');
  server.send({
    id: 72,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: {
        toolCallId: 'call_1__qwen_dup_3',
        title: 'Writing to w.txt',
        kind: 'edit',
        rawInput: { file_path: '/work/w.txt', content: 'x' },
        _meta: { toolName: 'write_file' },
      },
      options: [
        { optionId: 'proceed_always', name: 'Allow All Edits', kind: 'allow_always' },
        { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  expect(request.requestType).toBe('file_change_approval');
  expect(request.options.map((o) => o.decision)).toEqual([
    'acceptForSession',
    'accept',
    'decline',
    'cancel',
  ]);
});

const mcpRequest = (id: number, server: string) => ({
  id,
  method: 'session/request_permission',
  params: {
    sessionId: 'native',
    toolCall: {
      toolCallId: 'call_1__qwen_dup_4',
      title: '{"text":"S"}',
      kind: 'other',
      rawInput: { text: 'S' },
      _meta: { toolName: `mcp__${server}__echo` },
    },
    options: [
      {
        optionId: 'proceed_always_project',
        name: 'Always Allow in project: echo',
        kind: 'allow_always',
      },
      { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
    ],
  },
});

it('allows the session’s own MCP server without asking, and asks for any other', async () => {
  const { events, server } = await setup('approval-required');
  server.send(mcpRequest(73, 'switch'));
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
  expect(server.received.find((m) => m.id === 73)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'proceed_once' },
  });
  server.send(mcpRequest(74, 'elsewhere'));
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(1);
});

it('names the MCP server from the last update, and a subagent from the `agent` tool', () => {
  const { mcpServerOf, itemType } = qwenAcp;
  expect(
    mcpServerOf?.({
      toolCallId: 'c',
      _meta: { toolName: 'mcp__httpecho__http_echo', provenance: 'mcp', serverId: 'httpecho' },
    })
  ).toBe('httpecho');
  expect(mcpServerOf?.({ toolCallId: 'c', _meta: { toolName: 'tool_call' } })).toBeUndefined();
  expect(
    mcpServerOf?.({ toolCallId: 'c', _meta: { toolName: 'run_shell_command' } })
  ).toBeUndefined();
  expect(itemType?.({ toolCallId: 'c', _meta: { toolName: 'agent' } })).toBe('subagent');
  expect(itemType?.({ toolCallId: 'c', _meta: { toolName: 'tool_call' } })).toBeUndefined();
});

const questionRequest = (id: number) => {
  const questions = [
    {
      question: 'Pick many?',
      header: 'Many',
      options: [
        { label: 'Alpha', description: 'a' },
        { label: 'Beta', description: 'b' },
      ],
      multiSelect: true,
    },
    {
      question: 'Free?',
      header: 'Free',
      options: [{ label: 'X', description: 'x' }],
      multiSelect: false,
    },
  ];
  return {
    id,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: {
        toolCallId: 'call_1__qwen_dup_5',
        title: 'Ask user 2 questions',
        kind: 'think',
        rawInput: { questions },
        _meta: {
          toolName: 'ask_user_question',
          qwenInteractionKind: 'user_question',
          qwenQuestions: questions,
        },
      },
      options: [
        { optionId: 'proceed_once', name: 'Submit', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
      ],
    },
  };
};

it('answers Qwen’s questions by question number, a list for a multiple choice', async () => {
  const { adapter, events, server } = await setup('approval-required');
  server.send(questionRequest(75));
  const asked = events.find((e) => e.type === 'user-input.requested');
  if (!asked || asked.type !== 'user-input.requested') throw new Error('No question');
  expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
  expect(asked.questions.map((q) => [q.id, q.multiSelect, q.allowCustomAnswer])).toEqual([
    ['0', true, true],
    ['1', false, true],
  ]);
  await adapter.respondToUserInput('s', asked.requestId, {
    '0': ['Alpha', 'Beta'],
    '1': 'my own words',
  });
  await flush();
  expect(server.received.find((m) => m.id === 75)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'proceed_once' },
    answers: { '0': ['Alpha', 'Beta'], '1': 'my own words' },
  });
});

it('cancels a question that carries no questions', async () => {
  const { server } = await setup('approval-required');
  const request = questionRequest(76);
  request.params.toolCall._meta.qwenQuestions = [];
  server.send(request);
  await flush();
  expect(server.received.find((m) => m.id === 76)?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  });
});

const signIn = { binaryPath: 'qwen', cwd: '/work', env: {} };

it('is signed in when a session starts, and starts no prompt', async () => {
  expect(await checkAcpSignIn(qwenAcp, signIn)).toMatchObject({ status: 'authenticated' });
  expect(servers.at(-1)!.received.map((m) => m.method)).toEqual(['initialize', 'session/new']);
});

it('is signed out when it refuses a session, without signing in', async () => {
  qwen.signedIn = false;
  const result = await checkAcpSignIn(qwenAcp, signIn);
  expect(result).toMatchObject({ status: 'unauthenticated' });
  expect(result.message).toContain('/auth');
  expect(servers.at(-1)!.received.some((m) => m.method === 'authenticate')).toBe(false);
});
