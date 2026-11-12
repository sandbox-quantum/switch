import type * as childProcess from 'node:child_process';
import type * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof childProcess>()),
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      authMethods: [{ id: 'login', type: 'terminal', name: 'Login with Kimi account' }],
    }));
    server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createKimiAdapter, kimiAcp, kimiHome, kimiMcpServer, parseKimiProviders } =
  await import('./kimi-acp');

const flush = () => new Promise((resolve) => setImmediate(resolve));
let home: string;
beforeEach(async () => {
  servers.length = 0;
  home = await mkdtemp(join(tmpdir(), 'kimi-home-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function setup(runtimeMode: 'approval-required' | 'full-access' = 'approval-required') {
  const adapter = createKimiAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode,
    env: {},
    mcpServers: {
      switch: { transport: 'stdio', command: 'node', args: ['server.js'] },
    },
    connectorMcpServers: [],
  });
  return { adapter, events, server: servers.at(-1)! };
}

it('launches `kimi acp` with the update check off and sends no authenticate', async () => {
  const launch = await kimiAcp.launch({ binaryPath: '/bin/kimi', cwd: '/work', env: { A: '1' } });
  expect(launch).toEqual({
    command: '/bin/kimi',
    args: ['acp'],
    env: { A: '1', KIMI_CODE_NO_AUTO_UPDATE: '1' },
  });
  const { server } = await setup();
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
});

it('maps runtime modes onto Kimi permission levels, keeping questions in full access', () => {
  expect(kimiAcp.sessionMode?.('approval-required', undefined)).toBe('default');
  expect(kimiAcp.sessionMode?.('auto-accept-edits', undefined)).toBe('default');
  expect(kimiAcp.sessionMode?.('auto', undefined)).toBe('yolo');
  expect(kimiAcp.sessionMode?.('full-access', undefined)).toBe('yolo');
});

it('reads the MCP server from Kimi qualified tool names', () => {
  expect(kimiMcpServer({ toolCallId: 'a', title: 'mcp__switch__send_message' })).toBe('switch');
  expect(kimiMcpServer({ toolCallId: 'b', title: 'mcp__my-server__a_b' })).toBe('my-server');
  expect(kimiMcpServer({ toolCallId: 'c', title: 'Bash' })).toBeUndefined();
  expect(kimiMcpServer({ toolCallId: 'd' })).toBeUndefined();
  // A session server whose name Kimi folds is found by the folded name.
  const servers = new Set(['switch', 'my__server']);
  expect(kimiMcpServer({ toolCallId: 'e', title: 'mcp__my_server__a_b' }, servers)).toBe(
    'my__server'
  );
  expect(kimiMcpServer({ toolCallId: 'f', title: 'mcp__switch__post_message' }, servers)).toBe(
    'switch'
  );
  expect(kimiMcpServer({ toolCallId: 'g', title: 'mcp__other__tool' }, servers)).toBe('other');
});

it('types Agent and AgentSwarm calls as subagents, from either title or the arguments', () => {
  const type = (toolCall: Parameters<NonNullable<typeof kimiAcp.itemType>>[0]) =>
    kimiAcp.itemType?.(toolCall);
  expect(type({ toolCallId: 'a', title: 'Agent' })).toBe('subagent');
  expect(type({ toolCallId: 'b', title: 'AgentSwarm' })).toBe('subagent');
  expect(type({ toolCallId: 'c', title: 'Launching coder agent: Read README' })).toBe('subagent');
  expect(type({ toolCallId: 'd', title: 'Launching background explore agent: Scan' })).toBe(
    'subagent'
  );
  expect(
    type({
      toolCallId: 'e',
      title: 'Read README',
      rawInput: { prompt: 'p', description: 'Read README', subagent_type: 'coder' },
    })
  ).toBe('subagent');
  expect(type({ toolCallId: 'f', title: 'Bash', rawInput: { command: 'ls' } })).toBeUndefined();
});

it('auto-approves the session MCP server without asking', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'connect' });
  server.send({
    id: 90,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'call', title: 'mcp__switch__connect_to_room' },
      options: [
        { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });
  await flush();
  expect(events.some((e) => e.type === 'request.opened')).toBe(false);
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'approve_once' },
  });
});

it('asks Kimi questions as questions, not approvals, and answers with the option ID', async () => {
  const { adapter, events, server } = await setup('full-access');
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'ask me' });
  server.send({
    id: 91,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: {
        toolCallId: 'q',
        title: 'AskUserQuestion',
        content: [{ type: 'content', content: { type: 'text', text: 'Which color?' } }],
      },
      options: [
        { optionId: 'q0_opt_0', name: 'red', kind: 'allow_once' },
        { optionId: 'q0_opt_1', name: 'green', kind: 'allow_once' },
        { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' },
      ],
    },
  });
  const event = events.find((e) => e.type === 'user-input.requested');
  if (!event || event.type !== 'user-input.requested') throw new Error('missing question');
  expect(events.some((e) => e.type === 'request.opened')).toBe(false);
  expect(event.questions[0]).toMatchObject({
    question: 'Which color?',
    options: [
      { value: 'q0_opt_0', label: 'red' },
      { value: 'q0_opt_1', label: 'green' },
    ],
  });
  await adapter.respondToUserInput('s', event.requestId, { q: 'q0_opt_1' });
  await flush();
  expect(server.received.find((m) => m.id === 91)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'q0_opt_1' },
  });
});

it('cancels a question whose only option is to skip it', async () => {
  const { adapter, events, server } = await setup('full-access');
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'ask me' });
  server.send({
    id: 93,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'q', title: 'AskUserQuestion' },
      options: [{ optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' }],
    },
  });
  await flush();
  expect(events.some((e) => e.type === 'user-input.requested')).toBe(false);
  expect(server.received.find((m) => m.id === 93)?.result).toEqual({
    outcome: { outcome: 'cancelled' },
  });
});

it('asks with the tool title when a question carries no text', async () => {
  const { adapter, events, server } = await setup('full-access');
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'ask me' });
  server.send({
    id: 94,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'q', title: 'Pick a branch' },
      options: [
        { optionId: 'q0_opt_0', name: 'main', kind: 'allow_once' },
        { optionId: 'q0_opt_1', name: 'dev', kind: 'allow_once' },
      ],
    },
  });
  const event = events.find((e) => e.type === 'user-input.requested');
  if (!event || event.type !== 'user-input.requested') throw new Error('missing question');
  expect(event.questions[0]?.question).toBe('Pick a branch');
});

it('treats an ordinary approval as an approval', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run' });
  server.send({
    id: 92,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'bash', title: 'Bash', kind: 'execute' },
      options: [
        { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
        { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });
  expect(events.some((e) => e.type === 'request.opened')).toBe(true);
  expect(events.some((e) => e.type === 'user-input.requested')).toBe(false);
});

it('finds the data directory from KIMI_CODE_HOME, then the home directory', () => {
  expect(kimiHome({ KIMI_CODE_HOME: '/data/kimi' })).toBe('/data/kimi');
  expect(kimiHome({ HOME: '/home/a' })).toBe(join('/home/a', '.kimi-code'));
});

it('is signed out with no providers, and points at kimi login', async () => {
  const result = await parseKimiProviders('{"providers":{},"models":{}}', { KIMI_CODE_HOME: home });
  expect(result.status).toBe('unauthenticated');
  expect(result.message).toContain('kimi login');
});

it('counts a managed provider only while its credential file exists', async () => {
  const output = JSON.stringify({
    providers: { 'managed:kimi-code': { type: 'kimi', apiKey: '' } },
  });
  expect((await parseKimiProviders(output, { KIMI_CODE_HOME: home })).status).toBe(
    'unauthenticated'
  );
  await mkdir(join(home, 'credentials'), { recursive: true });
  await writeFile(join(home, 'credentials', 'kimi-code.json'), '{}');
  expect((await parseKimiProviders(output, { KIMI_CODE_HOME: home })).status).toBe('authenticated');
});

it('takes a configured API key as given, in the config or in a named variable', async () => {
  const configured = JSON.stringify({
    providers: { anthropic: { type: 'anthropic', apiKey: 'sk-x' } },
  });
  expect((await parseKimiProviders(configured, { KIMI_CODE_HOME: home })).status).toBe(
    'authenticated'
  );
  const byEnv = JSON.stringify({ providers: { moon: { type: 'kimi', apiKeyEnv: 'MOON_KEY' } } });
  expect((await parseKimiProviders(byEnv, { KIMI_CODE_HOME: home })).status).toBe('unknown');
  expect((await parseKimiProviders(byEnv, { KIMI_CODE_HOME: home, MOON_KEY: 'k' })).status).toBe(
    'authenticated'
  );
  const envTable = JSON.stringify({
    providers: { kimi: { type: 'kimi', env: { KIMI_API_KEY: 'k' } } },
  });
  expect((await parseKimiProviders(envTable, { KIMI_CODE_HOME: home })).status).toBe(
    'authenticated'
  );
});

it('reports unknown when the provider list cannot be read', async () => {
  expect(
    (await parseKimiProviders('error: unknown command', { KIMI_CODE_HOME: home })).status
  ).toBe('unknown');
});

const noConnection = () => {
  throw new Error('Kimi sign-in check asked for the connection');
};

it('treats a model defined in the environment as signed in without running the CLI', async () => {
  const result = await kimiAcp.checkSignIn!({
    binaryPath: '/nonexistent/kimi',
    cwd: '/work',
    env: { KIMI_MODEL_NAME: 'kimi-for-coding', KIMI_MODEL_API_KEY: 'k' },
    connection: noConnection,
    handshake: async () => {
      throw new Error('not called');
    },
    request: async () => {
      throw new Error('not called');
    },
  });
  expect(result.status).toBe('authenticated');
  // Without its key the model does not count, and the CLI is asked instead:
  // here there is none, which reads as unknown, never as signed in.
  const withoutKey = await kimiAcp.checkSignIn!({
    binaryPath: '/nonexistent/kimi',
    cwd: '/work',
    env: { KIMI_MODEL_NAME: 'kimi-for-coding', KIMI_CODE_HOME: home },
    connection: noConnection,
    handshake: async () => {
      throw new Error('not called');
    },
    request: async () => {
      throw new Error('not called');
    },
  });
  expect(withoutKey.status).toBe('unknown');
});

// A stand-in `kimi` that answers only `kimi provider list --json` run with the
// update check off, so the sign-in check's own command line is under test.
it.skipIf(process.platform === 'win32')(
  'reads the sign-in from `kimi provider list --json`, run with the update check off',
  async () => {
    const binaryPath = join(home, 'kimi');
    await writeFile(
      binaryPath,
      [
        '#!/bin/sh',
        '[ "$*" = "provider list --json" ] && [ "$KIMI_CODE_NO_AUTO_UPDATE" = "1" ] || exit 3',
        `echo '{"providers":{"managed:kimi-code":{"type":"kimi","apiKey":""}}}'`,
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    const notCalled = async (): Promise<never> => {
      throw new Error('not called');
    };
    const check = () =>
      kimiAcp.checkSignIn!({
        binaryPath,
        cwd: home,
        env: { KIMI_CODE_HOME: home },
        connection: noConnection,
        handshake: notCalled,
        request: notCalled,
      });
    expect((await check()).status).toBe('unauthenticated');
    await mkdir(join(home, 'credentials'), { recursive: true });
    await writeFile(join(home, 'credentials', 'kimi-code.json'), '{}');
    expect((await check()).status).toBe('authenticated');
  }
);
