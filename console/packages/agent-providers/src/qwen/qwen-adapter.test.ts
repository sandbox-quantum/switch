import type * as fs from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeMode } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';

/** The modes `qwen --acp` 0.26.5 advertises from `session/new`, signed in. */
const QWEN_MODES = ['plan', 'default', 'auto-edit', 'auto', 'yolo'];

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      authMethods: [{ id: 'openai', name: 'Use OpenAI API key' }],
    }));
    server.replyAlways('session/new', () => ({
      sessionId: 'native',
      modes: {
        currentModeId: 'auto',
        availableModes: QWEN_MODES.map((id) => ({ id, name: id })),
      },
    }));
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { QWEN_SIGN_IN, createQwenAdapter, qwenAcp } = await import('./qwen-adapter');
beforeEach(() => {
  servers.length = 0;
});
afterEach(() => {
  for (const server of servers) server.kill();
});

async function start(runtimeMode: RuntimeMode) {
  const adapter = createQwenAdapter();
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode,
    env: { OPENAI_API_KEY: 'synthetic-key' },
    mcpServers: {},
    connectorMcpServers: [],
  });
  return servers.at(-1)!;
}

it('puts each runtime mode in a mode Qwen advertises, never leaving its own auto', () => {
  const modes: Record<RuntimeMode, string | undefined> = {
    'approval-required': qwenAcp.sessionMode?.('approval-required'),
    'auto-accept-edits': qwenAcp.sessionMode?.('auto-accept-edits'),
    auto: qwenAcp.sessionMode?.('auto'),
    'full-access': qwenAcp.sessionMode?.('full-access'),
  };
  expect(modes).toEqual({
    'approval-required': 'default',
    'auto-accept-edits': 'auto-edit',
    auto: 'auto',
    'full-access': 'yolo',
  });
  for (const mode of Object.values(modes)) expect(QWEN_MODES).toContain(mode);
});

it('sets the mode right after the session starts, since Qwen starts every session in auto', async () => {
  const server = await start('approval-required');
  const methods = server.received.map((message) => message.method);
  expect(methods.slice(0, 3)).toEqual(['initialize', 'session/new', 'session/set_mode']);
  const setMode = server.received.find((message) => message.method === 'session/set_mode');
  expect(setMode?.params).toEqual({ sessionId: 'native', modeId: 'default' });
});

it('sends no authenticate, which would write the auth type into the person’s own settings', async () => {
  const server = await start('auto');
  expect(server.received.map((message) => message.method)).not.toContain('authenticate');
});

it('launches with the OpenAI auth type only when there is a key to sign in with', () => {
  const launch = (env: Record<string, string>) =>
    qwenAcp.launch({ binaryPath: '/bin/qwen', env } as Parameters<typeof qwenAcp.launch>[0]);
  expect(launch({ OPENAI_API_KEY: 'synthetic-key' })).toMatchObject({
    command: '/bin/qwen',
    args: ['--acp', '--auth-type=openai'],
  });
  expect(launch({})).toMatchObject({ args: ['--acp'] });
});

it('passes the OpenAI-compatible endpoint and model through to the CLI', () => {
  expect(qwenAcp.inheritEnv).toEqual(['OPENAI_BASE_URL', 'OPENAI_MODEL']);
});

it('answers sign-in from the key without starting the agent', async () => {
  const handshake = vi.fn(async () => {
    throw new Error('the sign-in check must not start the agent');
  });
  const check = (env: Record<string, string>) =>
    qwenAcp.checkSignIn!({ binaryPath: '/bin/qwen', cwd: '/work', env, handshake });

  await expect(check({ OPENAI_API_KEY: 'synthetic-key' })).resolves.toMatchObject({
    status: 'authenticated',
  });
  await expect(check({})).resolves.toMatchObject({
    status: 'unauthenticated',
    message: QWEN_SIGN_IN,
  });
  expect(handshake).not.toHaveBeenCalled();
});

it('asks Qwen’s own questions through Switch and answers them by question index', async () => {
  const askQuestions = vi.fn(async (questions, answer) =>
    answer([
      { questionId: questions[0].id, values: ['green'] },
      { questionId: questions[1].id, values: ['tests', 'lint'] },
    ])
  );
  const context = { askQuestions } as unknown as Parameters<
    NonNullable<typeof qwenAcp.permission>
  >[0];
  const request = {
    sessionId: 'native',
    options: [
      { optionId: 'proceed_once', name: 'Submit', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
    ],
    toolCall: {
      toolCallId: 'call-1',
      title: 'Ask user 2 questions',
      rawInput: {
        questions: [
          {
            question: 'Which color?',
            header: 'Color',
            options: [{ label: 'red' }, { label: 'green', description: 'the calm one' }],
          },
          {
            question: 'Which checks?',
            header: 'Checks',
            options: [{ label: 'tests' }, { label: 'lint' }],
            multiSelect: true,
          },
        ],
      },
    },
  } as unknown as Parameters<NonNullable<typeof qwenAcp.permission>>[1];

  const response = await qwenAcp.permission!(context, request);

  expect(askQuestions.mock.calls[0]![0]).toEqual([
    {
      id: '0',
      header: 'Color',
      question: 'Which color?',
      options: [
        { label: 'red', value: 'red' },
        { label: 'green', description: 'the calm one', value: 'green' },
      ],
      multiSelect: false,
      allowCustomAnswer: true,
    },
    {
      id: '1',
      header: 'Checks',
      question: 'Which checks?',
      options: [
        { label: 'tests', value: 'tests' },
        { label: 'lint', value: 'lint' },
      ],
      multiSelect: true,
      allowCustomAnswer: true,
    },
  ]);
  expect(response).toEqual({
    outcome: { outcome: 'selected', optionId: 'proceed_once' },
    answers: { '0': 'green', '1': 'tests, lint' },
  });
});

it('leaves an ordinary permission request to the approval flow', () => {
  const request = {
    sessionId: 'native',
    options: [],
    toolCall: {
      toolCallId: 'call-2',
      title: 'rm -f scratch.txt',
      rawInput: { command: 'rm -f scratch.txt' },
    },
  } as unknown as Parameters<NonNullable<typeof qwenAcp.permission>>[1];
  const context = {} as Parameters<NonNullable<typeof qwenAcp.permission>>[0];

  expect(qwenAcp.permission!(context, request)).toBeUndefined();
});

it('types Qwen’s agent tool as a subagent', () => {
  const call = (meta: Record<string, unknown>) =>
    ({ toolCallId: 'c', _meta: meta }) as unknown as Parameters<
      NonNullable<typeof qwenAcp.itemType>
    >[0];

  expect(qwenAcp.itemType?.(call({ toolName: 'agent', provenance: 'builtin' }))).toBe('subagent');
  expect(qwenAcp.itemType?.(call({ toolName: 'run_shell_command' }))).toBeUndefined();
});

it('types an agent reached through tool_call as a subagent once its input names it', () => {
  const call = (meta: Record<string, unknown>, rawInput: Record<string, unknown>) =>
    ({ toolCallId: 'c', _meta: meta, rawInput }) as unknown as Parameters<
      NonNullable<typeof qwenAcp.itemType>
    >[0];

  expect(qwenAcp.itemType?.(call({ toolName: 'tool_call' }, {}))).toBeUndefined();
  expect(
    qwenAcp.itemType?.(call({ toolName: 'tool_call' }, { name: 'agent', arguments: {} }))
  ).toBe('subagent');
  expect(
    qwenAcp.itemType?.(
      call({ toolName: 'tool_call' }, { name: 'read_mcp_resource', arguments: {} })
    )
  ).toBeUndefined();
});

it('finds the MCP server of a call, whether its update or its permission request names it', () => {
  const call = (meta: Record<string, unknown>, rawInput: Record<string, unknown> = {}) =>
    ({ toolCallId: 'c', _meta: meta, rawInput }) as unknown as Parameters<
      NonNullable<typeof qwenAcp.mcpServerOf>
    >[0];
  const server = (meta: Record<string, unknown>, rawInput?: Record<string, unknown>) =>
    qwenAcp.mcpServerOf?.(call(meta, rawInput));

  // A tool call's own update.
  expect(server({ toolName: 'mcp__echo__say', provenance: 'mcp', serverId: 'echo' })).toBe('echo');
  // A permission request, through `tool_call`, names only the tool…
  expect(server({ toolName: 'mcp__room_protocol__post_message' })).toBe('room_protocol');
  // …or, for a resource, the server in its input (as 0.26.5 sent it).
  expect(server({ toolName: 'read_mcp_resource' }, { server_name: 'echo', uri: 'PING' })).toBe(
    'echo'
  );
  expect(server({ toolName: 'read_file', provenance: 'builtin' })).toBeUndefined();
  expect(server({ toolName: 'mcp__' })).toBeUndefined();
});
