import type * as fs from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeMode } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
      },
      authMethods: [{ id: 'goose-provider', name: 'Configure Provider' }],
    }));
    server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createGooseAdapter, gooseAcp, parseGooseInfo } = await import('./goose-adapter');
beforeEach(() => {
  servers.length = 0;
});
async function setup(runtimeMode: RuntimeMode = 'approval-required') {
  const adapter = createGooseAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode,
    env: {},
    mcpServers: { switch: { transport: 'stdio', command: 'node', args: ['server.js'] } },
    connectorMcpServers: [],
  });
  const server = servers.at(-1)!;
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  await server.waitFor('session/prompt');
  return { adapter, events, server };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

// What Goose 1.57.0 sends: the tool call names its tool in `_meta`, the
// permission request for it does not, and the options are raw ids.
const toolCall = (toolCallId: string, extensionName: string, toolName: string, title: string) => ({
  sessionUpdate: 'tool_call',
  toolCallId,
  title,
  _meta: { goose: { toolCall: { toolName, extensionName } } },
});
const permission = (id: number, toolCallId: string, title: string, rawInput: object) => ({
  id,
  method: 'session/request_permission',
  params: {
    sessionId: 'native',
    toolCall: { toolCallId, title, kind: 'other', rawInput, _meta: null },
    options: ['allow_always', 'allow_once', 'reject_once', 'reject_always'].map((kind) => ({
      optionId: kind,
      name: kind,
      kind,
    })),
  },
});

it('puts every session in a Goose mode, since Goose defaults to approving everything', async () => {
  expect(
    (['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const).map((mode) =>
      gooseAcp.sessionMode?.(mode, undefined)
    )
  ).toEqual(['approve', 'approve', 'smart_approve', 'auto']);
  const { server } = await setup();
  expect(server.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
    sessionId: 'native',
    modeId: 'approve',
  });
});

it('asks for a shell command as a command, offering only the once options', async () => {
  const { adapter, events, server } = await setup();
  server.notify('session/update', {
    sessionId: 'native',
    update: toolCall('call_1', 'developer', 'shell', 'shell · ls'),
  });
  server.send(permission(91, 'call_1', 'shell · ls', { command: 'ls' }));
  await flush();
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  expect(request.requestType).toBe('command_execution_approval');
  expect(request.options).toEqual([
    { decision: 'accept', label: 'Allow once' },
    { decision: 'decline', label: 'Reject' },
    { decision: 'cancel', label: 'Cancel' },
  ]);
  const item = events.find((e) => e.type === 'item.started' || e.type === 'item.updated');
  expect(item && 'item' in item ? item.item.type : undefined).toBe('command_execution');
  await adapter.respondToRequest('s', request.requestId, 'accept');
  await flush();
  expect(server.received.find((m) => m.id === 91)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
});

it('accepts file writes and edits by itself in auto-accept-edits, and still asks for commands', async () => {
  const { events, server } = await setup('auto-accept-edits');
  server.send(permission(92, 'call_2', 'write · notes.txt', { path: 'notes.txt', content: 'hi' }));
  server.send(
    permission(93, 'call_3', 'edit · notes.txt', { path: 'notes.txt', before: 'a', after: 'b' })
  );
  await flush();
  for (const id of [92, 93])
    expect(server.received.find((m) => m.id === id)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
  server.send(permission(94, 'call_4', 'shell · rm -rf build', { command: 'rm -rf build' }));
  await flush();
  expect(events.some((e) => e.type === 'request.opened')).toBe(true);
});

it("runs the session's own MCP tools without asking, from the server named on the tool call", async () => {
  const { events, server } = await setup();
  server.notify('session/update', {
    sessionId: 'native',
    update: toolCall('call_5', 'switch', 'send_message', 'send_message · hello'),
  });
  server.send(permission(95, 'call_5', 'send_message · hello', { text: 'hello' }));
  await flush();
  expect(server.received.find((m) => m.id === 95)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
  expect(events.some((e) => e.type === 'request.opened')).toBe(false);
});

it("does not take Goose's own extensions for MCP servers", () => {
  for (const extension of ['developer', 'summon', 'analyze', 'Extension Manager'])
    expect(
      gooseAcp.mcpServerOf?.(
        {
          toolCallId: 'c',
          _meta: { goose: { toolCall: { toolName: 'x', extensionName: extension } } },
        },
        new Set()
      )
    ).toBeUndefined();
  expect(gooseAcp.mcpServerOf?.({ toolCallId: 'c' }, new Set())).toBeUndefined();
});

it('reads the provider and model from `goose info -v`', () => {
  const info = (configuration: string) =>
    `goose Version:\n  Version:                  1.57.0\n\nPaths:\nConfig dir:  /home/u/.config/goose\n\ngoose Configuration:\n${configuration}  extensions:\n    developer:\n      enabled: true\n`;
  expect(
    parseGooseInfo(info('  GOOSE_MODEL: gemini-3.5-flash\n  GOOSE_PROVIDER: google\n'))
  ).toMatchObject({ status: 'authenticated', message: 'Uses google (gemini-3.5-flash).' });
  expect(parseGooseInfo(info('')).status).toBe('unauthenticated');
  expect(parseGooseInfo(info('  GOOSE_PROVIDER: google\n')).status).toBe('unauthenticated');
  expect(
    parseGooseInfo('goose: unknown command "info"\nUsage: goose [OPTIONS] DRIVER DBSTRING')
  ).toMatchObject({
    status: 'unknown',
    message:
      'The `goose` on PATH is not the Goose agent CLI. Install Goose from https://goose-docs.ai.',
  });
});
