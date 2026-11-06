import { readFile, stat } from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import { PI_APPROVAL_OPTIONS, PI_APPROVAL_STATUS, PI_SWITCH_EXTENSION } from './switch-extension';

interface Spawned {
  server: FakeAppServer;
  args: string[];
  env: Record<string, string>;
  /** The settings file's contents, as the extension would read them at start. */
  settings: unknown;
}
const spawned: Spawned[] = [];
/** What the fake Pi has saved for the session id it is started with. */
const pi = { messageCount: 0 };
const records = (server: FakeAppServer, ...list: Array<Record<string, unknown>>) => {
  for (const record of list) server.sendRaw(JSON.stringify(record));
};
vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[], options: { env: Record<string, string> }) => {
    const server = new FakeAppServer();
    const entry: Spawned = { server, args, env: options.env, settings: undefined };
    server.on('message', async (message: { id?: string; type?: string }) => {
      if (message.id === undefined) return;
      const answer = (data?: unknown) =>
        records(server, {
          id: message.id,
          type: 'response',
          command: message.type,
          success: true,
          data,
        });
      switch (message.type) {
        case 'get_state':
          entry.settings = JSON.parse(await readFile(options.env.SWITCH_PI_CONFIG!, 'utf8'));
          return answer({
            sessionId: args[args.indexOf('--session-id') + 1],
            model: { provider: 'groq', id: 'llama-3.3-70b-versatile' },
            messageCount: pi.messageCount,
          });
        case 'prompt':
          return answer({ disposition: 'started' });
        case 'get_available_models':
          return answer({
            models: [
              {
                provider: 'groq',
                id: 'openai/gpt-oss-120b',
                name: 'GPT OSS 120B',
                input: ['text'],
              },
              { provider: 'anthropic', id: 'claude-sonnet-5', input: ['text', 'image'] },
            ],
          });
        default:
          return answer();
      }
    });
    spawned.push(entry);
    return server;
  },
}));
const { createPiAdapter, piExtensionConfig } = await import('./pi-adapter');

beforeEach(() => {
  spawned.length = 0;
  pi.messageCount = 0;
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
/** What the adapter wrote to Pi: Pi's own records, not JSON-RPC. */
const sent = (server: FakeAppServer) =>
  server.received as unknown as Array<Record<string, unknown> & { type?: string; id?: string }>;
const start = {
  sessionId: 's',
  cwd: '/work',
  runtimeMode: 'approval-required' as const,
  env: { PATH: '/bin', HELPER_TOKEN: 'from-env' },
  mcpServers: {
    switch: {
      transport: 'http' as const,
      url: 'http://127.0.0.1:4100/mcp',
      headers: { Authorization: 'Bearer synthetic' },
    },
    jira: {
      transport: 'stdio' as const,
      command: 'node',
      args: ['jira.js'],
      envVars: ['HELPER_TOKEN'],
    },
  },
  connectorMcpServers: ['jira'],
  systemContext: 'You are in a Switch room.',
  model: { id: 'groq/llama-3.3-70b-versatile' },
};

async function setup(
  overrides: Partial<typeof start> & { resume?: { nativeSessionId: string } } = {}
) {
  const adapter = createPiAdapter({ binaryPath: 'pi' });
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({ ...start, ...overrides });
  return { adapter, events, session, ...spawned.at(-1)! };
}
const of = <T extends ProviderRuntimeEvent['type']>(events: ProviderRuntimeEvent[], type: T) =>
  events.filter((e): e is Extract<ProviderRuntimeEvent, { type: T }> => e.type === type);

it('starts Pi in RPC mode with the Switch extension, the system context and the model', async () => {
  const { args, env, settings, session } = await setup();
  expect(args.slice(0, 3)).toEqual(['--mode', 'rpc', '--session-id']);
  expect(session.nativeSessionId).toBe(args[3]);
  const extension = args[args.indexOf('-e') + 1]!;
  expect(await readFile(extension, 'utf8')).toBe(PI_SWITCH_EXTENSION);
  const context = args[args.indexOf('--append-system-prompt') + 1]!;
  expect(await readFile(context, 'utf8')).toBe('You are in a Switch room.');
  expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
    '--model',
    'groq/llama-3.3-70b-versatile',
  ]);
  expect(settings).toEqual({
    runtimeMode: 'approval-required',
    mcpServers: {
      switch: { url: 'http://127.0.0.1:4100/mcp', headers: { Authorization: 'Bearer synthetic' } },
      jira: { command: 'node', args: ['jira.js'], env: { HELPER_TOKEN: 'from-env' } },
    },
    autoApproved: ['switch'],
  });
  // Read by the extension as Pi started, then removed: it holds bearer tokens.
  await expect(stat(env.SWITCH_PI_CONFIG!)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('resumes the exact conversation, and refuses one Pi has not saved', async () => {
  pi.messageCount = 4;
  const resumed = await setup({ resume: { nativeSessionId: 'saved-1' } });
  expect(resumed.args[3]).toBe('saved-1');
  expect(resumed.session.nativeSessionId).toBe('saved-1');
  pi.messageCount = 0;
  const adapter = createPiAdapter({ binaryPath: 'pi' });
  await expect(
    adapter.startSession({ ...start, sessionId: 'x', resume: { nativeSessionId: 'missing' } })
  ).rejects.toThrow(/no saved conversation/);
  expect(adapter.hasSession('x')).toBe(false);
});

it('streams a turn and ends it when Pi settles, with the usage of every model call', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'hello' });
  await flush();
  expect(sent(server).find((m) => m.type === 'prompt')).toMatchObject({ message: 'hello' });
  records(
    server,
    { type: 'agent_start' },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Hmm' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi ' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'there' } },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        model: 'llama-3.3-70b-versatile',
        content: [
          { type: 'thinking', thinking: 'Hmm.' },
          { type: 'text', text: 'Hi there' },
        ],
        usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 },
        stopReason: 'stop',
      },
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        model: 'llama-3.3-70b-versatile',
        content: [],
        usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
        stopReason: 'stop',
      },
    },
    { type: 'agent_end', messages: [] },
    { type: 'agent_settled', aborted: false }
  );
  await flush();
  expect(of(events, 'content.delta').map((e) => e.delta)).toEqual(['Hi ', 'there']);
  expect(of(events, 'item.completed').map((e) => [e.item.type, e.item.text])).toEqual([
    ['reasoning', 'Hmm.'],
    ['assistant_message', 'Hi there'],
  ]);
  expect(of(events, 'turn.completed')).toMatchObject([
    {
      turnId: 't',
      outcome: 'completed',
      usage: [
        {
          model: 'llama-3.3-70b-versatile',
          inputTokens: 15,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
        },
      ],
    },
  ]);
});

it('asks Switch before a tool runs, and marks a declined call', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run it' });
  await flush();
  records(
    server,
    {
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'rm -rf build' },
    },
    {
      type: 'extension_ui_request',
      id: 'ui-1',
      method: 'setStatus',
      statusKey: PI_APPROVAL_STATUS,
      statusText: JSON.stringify({
        toolCallId: 'c1',
        toolName: 'bash',
        input: { command: 'rm -rf build' },
      }),
    },
    {
      type: 'extension_ui_request',
      id: 'ui-2',
      method: 'select',
      title: 'Allow bash?',
      options: Object.values(PI_APPROVAL_OPTIONS),
    }
  );
  await flush();
  const [request] = of(events, 'request.opened');
  expect(request).toMatchObject({
    turnId: 't',
    requestType: 'command_execution_approval',
    title: 'Pi wants to run a command.',
    detail: 'rm -rf build',
    options: [
      { decision: 'accept', label: 'Allow once' },
      { decision: 'acceptForSession', label: 'Allow for this session' },
      { decision: 'decline', label: 'Reject' },
    ],
  });
  await adapter.respondToRequest('s', request!.requestId, 'decline');
  expect(sent(server).find((m) => m.type === 'extension_ui_response')).toEqual({
    type: 'extension_ui_response',
    id: 'ui-2',
    value: 'Reject',
  });
  records(server, {
    type: 'tool_execution_end',
    toolCallId: 'c1',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'The user declined this tool call.' }] },
    isError: true,
  });
  await flush();
  expect(of(events, 'item.completed').at(-1)?.item).toMatchObject({
    id: 'c1',
    type: 'command_execution',
    status: 'declined',
    title: 'rm -rf build',
  });
});

it("names the connector a tool belongs to, and answers other extensions' dialogs as cancelled", async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'look it up' });
  await flush();
  records(
    server,
    {
      type: 'extension_ui_request',
      id: 'ui-1',
      method: 'setStatus',
      statusKey: PI_APPROVAL_STATUS,
      statusText: JSON.stringify({
        toolCallId: 'c2',
        toolName: 'mcp__jira__search',
        input: { q: 'bug' },
      }),
    },
    {
      type: 'extension_ui_request',
      id: 'ui-2',
      method: 'select',
      title: 'Allow?',
      options: Object.values(PI_APPROVAL_OPTIONS),
    },
    { type: 'extension_ui_request', id: 'ui-3', method: 'confirm', title: 'Delete everything?' }
  );
  await flush();
  expect(of(events, 'request.opened')[0]).toMatchObject({
    requestType: 'mcp_tool_approval',
    title: 'Pi wants to use search from jira.',
    detail: '{"q":"bug"}',
    connector: 'jira',
  });
  expect(sent(server).find((m) => m.id === 'ui-3')).toEqual({
    type: 'extension_ui_response',
    id: 'ui-3',
    cancelled: true,
  });
  expect(of(events, 'runtime.warning')[0]?.message).toContain('Delete everything?');
});

it('interrupts with abort, cancelling a pending approval, then runs the next queued turn', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'first' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'second' });
  await flush();
  records(
    server,
    {
      type: 'extension_ui_request',
      id: 'ui-1',
      method: 'setStatus',
      statusKey: PI_APPROVAL_STATUS,
      statusText: JSON.stringify({ toolCallId: 'c1', toolName: 'write', input: { path: 'a.ts' } }),
    },
    {
      type: 'extension_ui_request',
      id: 'ui-2',
      method: 'select',
      title: 'Allow write?',
      options: Object.values(PI_APPROVAL_OPTIONS),
    }
  );
  await flush();
  expect(of(events, 'request.opened')[0]).toMatchObject({
    requestType: 'file_change_approval',
    detail: 'a.ts',
  });
  expect(sent(server).filter((m) => m.type === 'prompt')).toHaveLength(1);
  await adapter.interruptTurn('s');
  expect(sent(server).find((m) => m.id === 'ui-2')).toMatchObject({ cancelled: true });
  expect(sent(server).some((m) => m.type === 'abort')).toBe(true);
  expect(of(events, 'request.resolved')[0]).toMatchObject({ decision: 'cancel' });
  records(server, { type: 'agent_settled', aborted: true });
  await flush();
  expect(of(events, 'turn.completed')[0]).toMatchObject({ turnId: 'one', outcome: 'interrupted' });
  expect(
    sent(server)
      .filter((m) => m.type === 'prompt')
      .map((m) => m.message)
  ).toEqual(['first', 'second']);
});

it('fails the turn with the error the model provider reported', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'hi' });
  await flush();
  records(
    server,
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '429 rate limited',
      },
    },
    { type: 'agent_settled', aborted: false }
  );
  await flush();
  expect(of(events, 'turn.completed')[0]).toMatchObject({
    outcome: 'error',
    message: '429 rate limited',
    usage: [],
  });
});

it('ends the session and its turns when Pi exits, and removes its folder', async () => {
  const { adapter, events, server, args } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'hi' });
  await flush();
  server.kill();
  await flush();
  expect(of(events, 'turn.completed')[0]).toMatchObject({ outcome: 'error' });
  expect(of(events, 'session.exited')).toHaveLength(1);
  expect(adapter.hasSession('s')).toBe(false);
  await flush();
  await expect(stat(args[args.indexOf('-e') + 1]!)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('lists Pi’s models as provider/model and sets one by splitting at the first slash', async () => {
  const { adapter, server } = await setup();
  await expect(adapter.listModels('s')).resolves.toEqual([
    {
      id: 'groq/openai/gpt-oss-120b',
      label: 'GPT OSS 120B (groq)',
      options: {},
      imageInput: false,
    },
    {
      id: 'anthropic/claude-sonnet-5',
      label: 'claude-sonnet-5 (anthropic)',
      options: {},
      imageInput: true,
    },
  ]);
  await adapter.setModel('s', { id: 'groq/openai/gpt-oss-120b' });
  expect(sent(server).find((m) => m.type === 'set_model')).toMatchObject({
    provider: 'groq',
    modelId: 'openai/gpt-oss-120b',
  });
});

it('maps stdio and HTTP servers into Pi’s mcpServers shape', () => {
  expect(
    piExtensionConfig({ ...start, runtimeMode: 'full-access', connectorMcpServers: [] })
      .autoApproved
  ).toEqual(['switch', 'jira']);
});
