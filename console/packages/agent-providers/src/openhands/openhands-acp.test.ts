import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, realpath: async (path: string) => path };
});
const servers: FakeAppServer[] = [];
const spawned: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: { env: Record<string, string> }) => {
    spawned.push({ command, args, env: options.env });
    const server = new FakeAppServer();
    // What `openhands acp` 1.16 answers: an OpenHands Cloud auth method
    // whether or not it is in use, loadable sessions, and modes but no models.
    server.replyAlways('initialize', () => ({
      authMethods: [{ id: 'oauth', name: 'OAuth with OpenHands Cloud' }],
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true } },
    }));
    const modes = {
      availableModes: [{ id: 'always-ask' }, { id: 'always-approve' }, { id: 'llm-approve' }],
      currentModeId: 'always-ask',
    };
    server.replyAlways('session/new', () => ({ sessionId: 'native', modes }));
    server.replyAlways('session/load', () => ({ modes }));
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));
const {
  checkOpenhandsSettings,
  createOpenhandsAdapter,
  OPENHANDS_ACP_SHIM,
  openhandsAcp,
  openhandsHome,
  openhandsPython,
} = await import('./openhands-acp');

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
});

async function home(settings?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openhands-home-'));
  if (settings !== undefined) {
    await mkdir(join(dir, '.openhands'));
    await writeFile(join(dir, '.openhands', 'agent_settings.json'), settings);
  }
  return dir;
}
const configured = () => home(JSON.stringify({ llm: { model: 'openai/gpt-5-mini' } }));

/** An `openhands` entry point as `uv tool install` writes it. */
async function script(firstLine: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'openhands-bin-')), 'openhands');
  await writeFile(path, `${firstLine}\nimport sys\nfrom openhands_cli.entrypoint import main\n`);
  return path;
}

async function start(env: Record<string, string>, model?: string) {
  const adapter = createOpenhandsAdapter({
    binaryPath: await script('#!/opt/openhands/bin/python'),
  });
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env,
    mcpServers: {},
    connectorMcpServers: [],
    ...(model ? { model: { id: model } } : {}),
  });
  return { adapter, events, server: servers.at(-1)! };
}

it('runs its ACP server on its own Python, with the line limit raised and no banner', async () => {
  expect(
    await openhandsAcp.launch({
      binaryPath: await script('#!/opt/openhands/bin/python'),
      cwd: '/work',
      env: { HOME: '/h' },
    })
  ).toEqual({
    command: '/opt/openhands/bin/python',
    args: ['-I', '-c', OPENHANDS_ACP_SHIM],
    env: { HOME: '/h', OPENHANDS_SUPPRESS_BANNER: '1' },
  });
  expect(OPENHANDS_ACP_SHIM).toContain('limit=limit or 50 * 1024 * 1024');
  expect(OPENHANDS_ACP_SHIM).toContain("sys.argv = ['openhands', 'acp', *sys.argv[1:]]");
  expect(await openhandsPython(await script('#!/usr/bin/env python3.12'), undefined)).toBe(
    'python3.12'
  );
  const onPath = await script('#!/opt/openhands/bin/python');
  expect(await openhandsPython('openhands', `/nowhere${delimiter}${dirname(onPath)}`)).toBe(
    '/opt/openhands/bin/python'
  );
});

it('resumes a conversation by launching with it, since its session/load drops the MCP servers', async () => {
  const launched = await openhandsAcp.launch({
    binaryPath: await script('#!/opt/openhands/bin/python'),
    cwd: '/work',
    env: {},
    resume: '6f1c0e52-3a1b-4b6d-9a40-1d2e3f4a5b6c',
  });
  expect(launched.args).toEqual([
    '-I',
    '-c',
    OPENHANDS_ACP_SHIM,
    '--resume',
    '6f1c0e52-3a1b-4b6d-9a40-1d2e3f4a5b6c',
  ]);
  const home = await configured();
  const saved = '6f1c0e52-3a1b-4b6d-9a40-1d2e3f4a5b6c';
  await mkdir(join(home, '.openhands', 'conversations', saved.replaceAll('-', '')), {
    recursive: true,
  });
  await writeFile(
    join(home, '.openhands', 'conversations', saved.replaceAll('-', ''), 'base_state.json'),
    '{}'
  );
  expect(await openhandsAcp.resumesAtLaunch?.(saved, { HOME: home })).toBe(true);
  expect(
    await openhandsAcp.resumesAtLaunch?.('0b8a6c2e-1111-4b6d-9a40-1d2e3f4a5b6c', { HOME: home })
  ).toBe(false);
});

it('reports its single-file build as set up wrongly, not signed out, before any session', async () => {
  const binary = await script('\u007fELF');
  expect(
    await openhandsAcp.checkSignIn?.({
      binaryPath: binary,
      cwd: '/work',
      env: { HOME: await configured() },
      handshake: async () => ({}),
    })
  ).toMatchObject({ status: 'unconfigured', loginHelps: false });
});

it('refuses an install it cannot run on Python, saying how to install one it can', async () => {
  for (const binaryPath of [await script('#!/bin/sh'), join(tmpdir(), 'no-such-openhands')])
    await expect(openhandsAcp.launch({ binaryPath, cwd: '/work', env: {} })).rejects.toThrow(
      'Install it with: uv tool install openhands --python 3.12'
    );
});

it('is signed in once its settings name a model, and says which', async () => {
  expect(await checkOpenhandsSettings({ HOME: await configured() })).toMatchObject({
    status: 'authenticated',
    message: 'Set up to run openai/gpt-5-mini.',
  });
});

it('is signed out without settings, or with settings that name no model', async () => {
  for (const settings of [undefined, '{not json', JSON.stringify({ llm: {} })])
    expect(await checkOpenhandsSettings({ HOME: await home(settings) })).toMatchObject({
      status: 'unauthenticated',
      message:
        'OpenHands has no LLM set up. On the execution machine, run openhands and choose its LLM in /settings.',
    });
});

it('reads its settings from OPENHANDS_PERSISTENCE_DIR when that is set', async () => {
  const persisted = join(await configured(), '.openhands');
  const env = { HOME: '/elsewhere', OPENHANDS_PERSISTENCE_DIR: persisted };
  expect(openhandsHome(env)).toBe(persisted);
  expect(await checkOpenhandsSettings(env)).toMatchObject({ status: 'authenticated' });
  expect(openhandsAcp.inheritEnv).toEqual(['OPENHANDS_PERSISTENCE_DIR']);
});

it('reports a settings file it cannot read rather than calling the CLI signed out', async () => {
  const dir = await home();
  await mkdir(join(dir, '.openhands', 'agent_settings.json'), { recursive: true });
  await expect(checkOpenhandsSettings({ HOME: dir })).rejects.toThrow('EISDIR');
});

it('maps Switch runtime modes onto its confirmation modes', () => {
  expect(openhandsAcp.sessionMode?.('approval-required')).toBe('always-ask');
  expect(openhandsAcp.sessionMode?.('auto-accept-edits')).toBe('always-ask');
  expect(openhandsAcp.sessionMode?.('auto')).toBe('llm-approve');
  expect(openhandsAcp.sessionMode?.('full-access')).toBe('always-approve');
});

it('starts without signing in to OpenHands Cloud, offering the model in its settings', async () => {
  const { adapter, server } = await start({ HOME: await configured() }, 'openai/gpt-5-mini');
  expect(server.received.map((m) => m.method)).toEqual([
    'initialize',
    'session/new',
    'session/set_mode',
  ]);
  expect(await adapter.listModels('s')).toEqual([
    { id: 'openai/gpt-5-mini', label: 'openai/gpt-5-mini', options: {} },
  ]);
  await adapter.setModel('s', { id: 'anthropic/claude-haiku-4-5' });
  expect(server.received.some((m) => m.method === 'session/set_model')).toBe(false);
  await adapter.stopAll();
});

it('puts an MCP call on the session server only when it can be on no other', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openhands-mcp-'));
  const env = { OPENHANDS_PERSISTENCE_DIR: dir };
  const mcp = { toolCallId: 'c', rawInput: { kind: 'MCPToolAction', data: { text: 'hi' } } };
  const one = { mcpServers: new Set(['switch']), env };
  expect(openhandsAcp.mcpServerOf?.(mcp, one)).toBe('switch');
  expect(
    openhandsAcp.mcpServerOf?.(mcp, { mcpServers: new Set(['switch', 'linear']), env })
  ).toBeUndefined();
  expect(
    openhandsAcp.mcpServerOf?.({ toolCallId: 'c', rawInput: { kind: 'TerminalAction' } }, one)
  ).toBeUndefined();
  await writeFile(
    join(dir, 'mcp.json'),
    JSON.stringify({ mcpServers: { own: { command: 'x', enabled: false } } })
  );
  expect(openhandsAcp.mcpServerOf?.(mcp, one)).toBe('switch');
  await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { own: { command: 'x' } } }));
  expect(openhandsAcp.mcpServerOf?.(mcp, one)).toBeUndefined();
  await writeFile(join(dir, 'mcp.json'), '{not json');
  expect(openhandsAcp.mcpServerOf?.(mcp, one)).toBeUndefined();
});

it('types its task tool as a subagent', () => {
  expect(
    openhandsAcp.itemType?.({ toolCallId: 'c', rawInput: { kind: 'TaskAction', prompt: 'p' } })
  ).toBe('subagent');
  expect(
    openhandsAcp.itemType?.({ toolCallId: 'c', rawInput: { kind: 'TerminalAction' } })
  ).toBeUndefined();
});

it('shows what "Confirm Agent Actions" covers, from the actions it announced', async () => {
  const { adapter, events, server } = await start({ HOME: await configured() });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  server.send({
    method: 'session/update',
    params: {
      sessionId: 'native',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        kind: 'execute',
        title: 'Write the marker file: echo token > approved.txt',
        status: 'in_progress',
        rawInput: { kind: 'TerminalAction', command: 'echo token > approved.txt' },
      },
    },
  });
  // The request OpenHands 1.16 sends: a synthetic call, and options that
  // include turning confirmation off for the rest of the conversation.
  server.send({
    id: 90,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: {
        toolCallId: 'confirmation-native',
        kind: 'other',
        status: 'pending',
        title: 'Confirm Agent Actions',
      },
      options: [
        { optionId: 'accept', name: 'Yes, proceed', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        {
          optionId: 'always_proceed',
          name: "Always proceed (don't ask again)",
          kind: 'allow_always',
        },
        { optionId: 'risk_based', name: 'Auto-confirm LOW/MEDIUM risk', kind: 'allow_once' },
      ],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const opened = events.find((e) => e.type === 'request.opened');
  if (opened?.type !== 'request.opened') throw new Error('No approval');
  expect(opened.requestType).toBe('command_execution_approval');
  expect(opened.title).toBe('Write the marker file: echo token > approved.txt');
  await adapter.respondToRequest('s', opened.requestId, 'decline');
  await new Promise((resolve) => setImmediate(resolve));
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'reject' },
  });
  await adapter.stopAll();
});
