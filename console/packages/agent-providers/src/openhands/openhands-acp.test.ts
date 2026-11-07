import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import type { ProviderSessionStartInput, RuntimeMode } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

const children: Array<{ server: FakeAppServer; args: string[] }> = [];
const NATIVE = '11111111-2222-3333-4444-555555555555';
vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[]) => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({ agentCapabilities: { loadSession: true } }));
    server.replyAlways('session/new', () => ({
      sessionId: args.includes('--resume') ? args.at(-1) : NATIVE,
      modes: {
        availableModes: ['always-ask', 'always-approve', 'llm-approve'].map((id) => ({ id })),
        currentModeId: 'always-ask',
      },
    }));
    server.replyAlways('session/set_mode', () => ({}));
    children.push({ server, args });
    return server;
  },
}));
const { createOpenhandsAdapter, openhandsAcp } = await import('./openhands-acp');
let directory: string;
const adapters: ReturnType<typeof createOpenhandsAdapter>[] = [];
beforeEach(async () => {
  children.length = 0;
  directory = await mkdtemp(join(tmpdir(), 'switch-openhands-unit-'));
  await writeFile(
    join(directory, 'agent_settings.json'),
    JSON.stringify({ llm: { model: 'openai/test-model' } })
  );
});
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stopAll()));
  await rm(directory, { recursive: true, force: true });
});

async function start(overrides: Partial<ProviderSessionStartInput> = {}) {
  const adapter = createOpenhandsAdapter({
    mcpBridge: { transport: 'stdio', command: 'node', args: ['host.mjs', '--openhands-mcp'] },
  });
  adapters.push(adapter);
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const input: ProviderSessionStartInput = {
    sessionId: 'test',
    cwd: directory,
    runtimeMode: 'approval-required',
    env: { OPENHANDS_PERSISTENCE_DIR: directory },
    mcpServers: {},
    connectorMcpServers: [],
    ...overrides,
  };
  await adapter.startSession(input);
  return { adapter, events, server: children.at(-1)!.server };
}

it('discovers the configured model without launching login or a session', async () => {
  const input = {
    binaryPath: 'openhands',
    cwd: directory,
    env: { OPENHANDS_PERSISTENCE_DIR: directory },
  };
  expect(await checkAcpSignIn(openhandsAcp, input)).toMatchObject({
    status: 'authenticated',
    models: [{ id: 'openai/test-model' }],
  });
  await writeFile(join(directory, 'agent_settings.json'), '{}');
  expect(await checkAcpSignIn(openhandsAcp, input)).toMatchObject({
    status: 'unauthenticated',
    models: [],
  });
  await writeFile(join(directory, 'agent_settings.json'), '{broken');
  expect(await checkAcpSignIn(openhandsAcp, input)).toMatchObject({ status: 'unknown' });
  expect(children).toHaveLength(0);
});

it('rejects a stale model selection before spawn and never sends the no-op model RPC', async () => {
  await expect(start({ model: { id: 'wrong-model' } })).rejects.toThrow('configured model');
  expect(children).toHaveLength(0);
  const { adapter, server } = await start({ model: { id: 'openai/test-model' } });
  expect(await adapter.listModels('test')).toEqual([
    { id: 'openai/test-model', label: 'openai/test-model', options: {} },
  ]);
  await adapter.setModel('test', { id: 'openai/test-model' });
  await expect(adapter.setModel('test', { id: 'other' })).rejects.toThrow('cannot switch');
  expect(server.received.some((message) => message.method === 'session/set_model')).toBe(false);
});

it.each<[RuntimeMode, string]>([
  ['approval-required', 'always-ask'],
  ['auto-accept-edits', 'always-ask'],
  ['auto', 'llm-approve'],
  ['full-access', 'always-approve'],
])('enforces %s with OpenHands mode %s', async (runtimeMode, modeId) => {
  const { server } = await start({ runtimeMode });
  expect(
    server.received.find((message) => message.method === 'session/set_mode')?.params
  ).toMatchObject({ modeId });
});

it('resumes a saved UUID through launch and reattaches the current MCP servers', async () => {
  const saved = join(directory, 'conversations', NATIVE.replaceAll('-', ''));
  await mkdir(saved, { recursive: true });
  await writeFile(join(saved, 'base_state.json'), '{}');
  const { server } = await start({
    resume: { nativeSessionId: NATIVE },
    mcpServers: {
      switch: {
        transport: 'http',
        url: 'http://127.0.0.1/mcp',
        headers: { Authorization: 'Bearer test-fixture' },
      },
    },
  });
  expect(children[0]?.args).toEqual(['acp', '--resume', NATIVE]);
  expect(server.received.some((message) => message.method === 'session/load')).toBe(false);
  const servers = server.received.find((message) => message.method === 'session/new')?.params
    ?.mcpServers as Array<{
    command: string;
    args: string[];
    env: Array<{ name: string; value: string }>;
  }>;
  expect(servers[0]?.command).toBe('node');
  expect(servers[0]?.args.join(' ')).not.toContain('test-fixture');
  expect(servers[0]?.env.find((entry) => entry.name === 'SWITCH_OPENHANDS_MCP')?.value).toContain(
    'Bearer test-fixture'
  );
});

it('refuses an unavailable or invalid resume ID before spawning', async () => {
  await expect(start({ resume: { nativeSessionId: NATIVE } })).rejects.toThrow('not available');
  await expect(start({ resume: { nativeSessionId: '../escape' } })).rejects.toThrow('Invalid');
  expect(children).toHaveLength(0);
});

it('queues mid-turn input and stops a pending permission with an error on interrupt', async () => {
  const { adapter, server, events } = await start();
  await adapter.sendTurn({ sessionId: 'test', turnId: 'first', text: 'work' });
  await server.waitFor('session/prompt');
  await adapter.sendTurn({ sessionId: 'test', turnId: 'second', text: 'next' });
  expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(1);
  server.send({
    id: 900,
    method: 'session/request_permission',
    params: {
      sessionId: NATIVE,
      toolCall: {
        toolCallId: 'action',
        title: 'Confirm Agent Actions',
        kind: 'other',
        status: 'pending',
      },
      options: [
        { kind: 'allow_once', name: 'Proceed', optionId: 'accept' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
      ],
    },
  });
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === 'request.opened')).toBe(true)
  );
  await adapter.interruptTurn('test');
  await vi.waitFor(() =>
    expect(server.received.find((message) => message.id === 900)?.error).toBeDefined()
  );
  const first = server.received.find((message) => message.method === 'session/prompt')!;
  server.send({ id: first.id, result: { stopReason: 'cancelled' } });
  await vi.waitFor(() =>
    expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(2)
  );
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'turn.completed', turnId: 'first', outcome: 'interrupted' })
  );
});

it('delivers long escaped context under 64 KiB per line and only displays the final answer', async () => {
  const { adapter, server, events } = await start({
    systemContext: '😀 "context"\\\n'.repeat(8000),
  });
  server.replyAlways('session/prompt', (params) => {
    const final = String((params.prompt as Array<{ text: string }>)[0]?.text).startsWith(
      'Final part'
    );
    server.notify('session/update', {
      sessionId: NATIVE,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: final ? 'READY' : 'OK' },
      },
    });
    return { stopReason: 'end_turn' };
  });
  await adapter.sendTurn({ sessionId: 'test', turnId: 'long', text: 'answer' });
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === 'turn.completed')).toBe(true)
  );
  const prompts = server.received.filter((message) => message.method === 'session/prompt');
  expect(prompts.length).toBeGreaterThan(1);
  for (const message of prompts)
    expect(
      Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
    ).toBeLessThanOrEqual(65536);
  expect(JSON.stringify(events)).toContain('READY');
  expect(
    events
      .filter((event) => event.type === 'item.completed')
      .map((event) => event.item.text)
      .join('')
  ).not.toContain('OK');
});
