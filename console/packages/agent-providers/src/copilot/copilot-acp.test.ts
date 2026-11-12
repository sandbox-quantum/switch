import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeMode } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

const servers: FakeAppServer[] = [];
const spawned: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
/** Whether `session/new` is refused the way Copilot refuses it with no usable sign-in. */
let signedOut = false;
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: { env: Record<string, string> }) => {
    spawned.push({ command, args, env: options.env });
    const server = new FakeAppServer();
    // What Copilot CLI 1.0.105 answers, trimmed to what the adapter reads.
    server.replyAlways('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
      },
      authMethods: [{ id: 'copilot-login', name: 'Log in with Copilot CLI' }],
    }));
    server.on('message', (message: { id?: number; method?: string }) => {
      if (message.method !== 'session/new' || message.id === undefined) return;
      server.send(
        signedOut
          ? { id: message.id, error: { code: -32000, message: 'Authentication required' } }
          : { id: message.id, result: { sessionId: 'native' } }
      );
    });
    server.replyAlways('session/set_model', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { checkAcpSignIn } = await import('../acp/acp-adapter');
const { EXECUTION_INHERIT_ENV } = await import('../host/agent-env');
const { copilotAcp, createCopilotAdapter } = await import('./copilot-acp');

let home: string;
beforeEach(async () => {
  servers.length = 0;
  spawned.length = 0;
  signedOut = false;
  home = await mkdtemp(join(tmpdir(), 'copilot-acp-test-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
const signIn = (env: Record<string, string>) =>
  checkAcpSignIn(copilotAcp, { binaryPath: 'copilot', cwd: home, env: { HOME: home, ...env } });

/** The way `copilot` writes its managed config.json. */
async function writeConfig(dir: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'config.json'),
    `// User settings belong in settings.json.\n// This file is managed automatically.\n${JSON.stringify(config, null, 2)}\n`
  );
}

const user = { host: 'https://github.com', login: 'octocat' };

it('runs on a custom model provider only when it also names a model, before any sign-in', async () => {
  const provider = { COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:11434/v1' };
  await expect(signIn({ ...provider, COPILOT_MODEL: 'qwen3-coder' })).resolves.toMatchObject({
    status: 'authenticated',
  });
  await expect(
    signIn({ ...provider, COPILOT_PROVIDER_MODEL_ID: 'gpt-5.4' })
  ).resolves.toMatchObject({ status: 'authenticated' });
  const unconfigured = {
    status: 'unconfigured',
    message:
      'COPILOT_PROVIDER_BASE_URL names a custom model provider, which also needs a model: set COPILOT_MODEL.',
    models: [],
    loginHelps: false,
  };
  await expect(signIn(provider)).resolves.toEqual(unconfigured);
  await writeConfig(join(home, '.copilot'), { lastLoggedInUser: user, loggedInUsers: [user] });
  await expect(signIn({ ...provider, COPILOT_GITHUB_TOKEN: 'token-placeholder' })).resolves.toEqual(
    unconfigured
  );
});

it('takes COPILOT_GITHUB_TOKEN as the sign-in, and not the GH_TOKEN or GITHUB_TOKEN a session is not given', async () => {
  await expect(signIn({ COPILOT_GITHUB_TOKEN: 'token-placeholder' })).resolves.toEqual({
    status: 'authenticated',
    message: 'Signs in with the COPILOT_GITHUB_TOKEN it was given.',
    models: [],
  });
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN'])
    await expect(signIn({ [name]: 'token-placeholder' })).resolves.toMatchObject({
      status: 'unauthenticated',
    });
});

it('reads the saved login from COPILOT_HOME, else ~/.copilot, without starting Copilot', async () => {
  await writeConfig(join(home, '.copilot'), { firstLaunchAt: '2026-11-05T05:01:48.943Z' });
  await expect(signIn({})).resolves.toEqual({
    status: 'unauthenticated',
    message:
      'Sign in on the execution machine with copilot login. Or give it a token in COPILOT_GITHUB_TOKEN, or a model provider of your own in COPILOT_PROVIDER_BASE_URL and COPILOT_MODEL.',
    models: [],
  });
  await writeConfig(join(home, '.copilot'), { lastLoggedInUser: user, loggedInUsers: [user] });
  await expect(signIn({})).resolves.toMatchObject({
    status: 'authenticated',
    message: 'Signed in to https://github.com as octocat.',
  });
  const elsewhere = join(home, 'copilot-home');
  await expect(signIn({ COPILOT_HOME: elsewhere })).resolves.toMatchObject({
    status: 'unauthenticated',
  });
  const hubot = { ...user, login: 'hubot' };
  await writeConfig(elsewhere, { lastLoggedInUser: hubot, loggedInUsers: [user, hubot] });
  await expect(signIn({ COPILOT_HOME: elsewhere })).resolves.toMatchObject({
    status: 'authenticated',
    message: 'Signed in to https://github.com as hubot.',
  });
  // Signed out: the last account is still remembered but no longer listed, or a login is empty.
  for (const config of [
    { lastLoggedInUser: hubot, loggedInUsers: [user] },
    { lastLoggedInUser: hubot },
    { lastLoggedInUser: { ...user, login: '' }, loggedInUsers: [{ ...user, login: '' }] },
  ]) {
    await writeConfig(elsewhere, config);
    await expect(signIn({ COPILOT_HOME: elsewhere })).resolves.toMatchObject({
      status: 'unauthenticated',
    });
  }
  await writeFile(join(elsewhere, 'config.json'), '{ "lastLoggedInUser": ');
  await expect(signIn({ COPILOT_HOME: elsewhere })).resolves.toMatchObject({
    status: 'unknown',
  });
  expect(spawned).toEqual([]);
});

it('counts only what a session is given, and keeps GH_TOKEN and GITHUB_TOKEN on the machine', async () => {
  const given = (env: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(env).filter(([name]) => EXECUTION_INHERIT_ENV.includes(name))
    );
  const elsewhere = join(home, 'copilot-home');
  await writeConfig(elsewhere, { lastLoggedInUser: user, loggedInUsers: [user] });
  const environments: Array<Record<string, string>> = [
    { COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:11434/v1', COPILOT_MODEL: 'qwen3-coder' },
    { COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:11434/v1', COPILOT_PROVIDER_MODEL_ID: 'gpt' },
    { COPILOT_GITHUB_TOKEN: 'token-placeholder' },
    { COPILOT_HOME: elsewhere },
    { GH_TOKEN: 'token-placeholder', GITHUB_TOKEN: 'token-placeholder' },
  ];
  for (const env of environments) expect(await signIn(given(env))).toEqual(await signIn(env));
  expect(EXECUTION_INHERIT_ENV).toContain('GH_HOST');
  expect(EXECUTION_INHERIT_ENV).not.toContain('GH_TOKEN');
  expect(EXECUTION_INHERIT_ENV).not.toContain('GITHUB_TOKEN');
});

it('starts `copilot --acp --stdio` with the session environment, and signs nothing in', async () => {
  const adapter = createCopilotAdapter({ binaryPath: '/opt/bin/copilot' });
  const env = { HOME: home, COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:1/v1' };
  await adapter.startSession({
    sessionId: 's',
    cwd: home,
    runtimeMode: 'approval-required',
    env,
    mcpServers: {},
    connectorMcpServers: [],
    model: { id: 'qwen3-coder' },
  });
  expect(spawned).toEqual([{ command: '/opt/bin/copilot', args: ['--acp', '--stdio'], env }]);
  const methods = servers[0]!.received.map((message) => message.method).filter(Boolean);
  expect(methods).toEqual(['initialize', 'session/new', 'session/set_model']);
});

it('says to sign in with copilot login when Copilot refuses a session for want of one', async () => {
  // A saved login whose token is gone still reads as signed in; the session says otherwise.
  signedOut = true;
  await expect(
    createCopilotAdapter().startSession({
      sessionId: 's',
      cwd: home,
      runtimeMode: 'approval-required',
      env: { HOME: home },
      mcpServers: {},
      connectorMcpServers: [],
    })
  ).rejects.toThrow(
    'Authentication required. Sign in on the execution machine with copilot login.'
  );
});

async function session(runtimeMode: RuntimeMode = 'approval-required') {
  const adapter = createCopilotAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const http = (port: number) => ({
    transport: 'http' as const,
    url: `http://127.0.0.1:${port}/mcp`,
  });
  await adapter.startSession({
    sessionId: 's',
    cwd: home,
    runtimeMode,
    env: {},
    mcpServers: { switch: http(1), google: http(2), 'google-workspace': http(3) },
    connectorMcpServers: ['google', 'google-workspace'],
  });
  const server = servers.at(-1)!;
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  const announce = (toolCallId: string, title: string, kind: string, rawInput = {}) =>
    server.notify('session/update', {
      sessionId: 'native',
      update: { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'pending', rawInput },
    });
  // Copilot's options, in its order: allow once, for the session, and deny.
  const ask = (id: number, toolCall: Record<string, unknown>) =>
    server.send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { status: 'pending', ...toolCall },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
        ],
      },
    });
  // The adapter's own requests are numbered from 1; these are Copilot's.
  const answer = (id: number) =>
    server.received.find((message) => message.id === id && 'result' in message)?.result;
  return { adapter, events, server, announce, ask, answer };
}

it('lets Switch tools run in approval-required and asks for connectors, by the announced server', async () => {
  const { events, server, announce, ask, answer } = await session();
  announce('call_1', 'switch-post_message', 'other', { text: 'hello' });
  // An update naming nothing leaves the call as it was announced.
  server.notify('session/update', {
    sessionId: 'native',
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress' },
  });
  ask(101, { toolCallId: 'call_1', title: 'post_message', kind: 'other' });
  announce('call_2', 'google-workspace-search', 'other');
  ask(102, { toolCallId: 'call_2', title: 'search', kind: 'other' });
  await flush();
  expect(answer(101)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
  const opened = events.filter((event) => event.type === 'request.opened');
  expect(opened).toMatchObject([
    { requestType: 'mcp_tool_approval', title: 'search', connector: 'google-workspace' },
  ]);
  expect(events.find((event) => event.type === 'item.started')).toMatchObject({
    item: { id: 'call_1', type: 'mcp_tool_call', title: 'switch-post_message' },
  });
});

it('asks before a command whose model-written title looks like a Switch tool', async () => {
  const { adapter, events, announce, ask, answer } = await session();
  announce('call_3', 'switch-cleanup', 'execute', { command: 'rm -rf build' });
  ask(103, { toolCallId: 'call_3', title: 'switch-cleanup', kind: 'execute' });
  await flush();
  expect(events.find((event) => event.type === 'item.started')).toMatchObject({
    item: { id: 'call_3', type: 'command_execution' },
  });
  const request = events.find((event) => event.type === 'request.opened');
  if (request?.type !== 'request.opened') throw new Error('No approval');
  expect(request).toMatchObject({ requestType: 'command_execution_approval' });
  expect(request.options.map((option) => [option.decision, option.label])).toEqual([
    ['accept', 'Allow once'],
    ['acceptForSession', 'Always allow'],
    ['decline', 'Deny'],
    ['cancel', 'Cancel'],
  ]);
  await adapter.respondToRequest('s', request.requestId, 'decline');
  await flush();
  expect(answer(103)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject_once' } });
});

it("asks before a tool on a server of Copilot's own whose name starts with a session server's", async () => {
  const { events, announce, ask, answer } = await session();
  // What Copilot CLI 1.0.105 sends for a `switch-home` server in ~/.copilot/mcp-config.json.
  announce('call_9', 'switch-home-echo', 'other', { text: 'lights off' });
  ask(109, {
    toolCallId: 'call_9',
    title: 'echo',
    kind: 'other',
    rawInput: { text: 'lights off' },
  });
  // And a request for a call it never announced.
  ask(110, { toolCallId: 'call_10', title: 'switch-post_message', kind: 'other' });
  await flush();
  expect(answer(109)).toBeUndefined();
  expect(answer(110)).toBeUndefined();
  expect(events.filter((event) => event.type === 'request.opened')).toMatchObject([
    { requestType: 'tool_approval', title: 'echo' },
    { requestType: 'tool_approval', title: 'switch-post_message' },
  ]);
});

it('answers commands itself in full access and edits in auto-accept-edits', async () => {
  const full = await session('full-access');
  full.ask(104, { toolCallId: 'call_4', title: 'Write approved.txt', kind: 'execute' });
  await flush();
  expect(full.answer(104)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
  const edits = await session('auto-accept-edits');
  edits.ask(105, { toolCallId: 'call_5', title: 'Create file', kind: 'edit' });
  edits.ask(106, { toolCallId: 'call_6', title: 'Write approved.txt', kind: 'execute' });
  await flush();
  expect(edits.answer(105)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
  expect(edits.events.filter((event) => event.type === 'request.opened')).toMatchObject([
    { requestType: 'command_execution_approval', title: 'Write approved.txt' },
  ]);
});

it('shows the task tool as a subagent, through to its result', async () => {
  const { events, server, announce } = await session();
  announce('call_8', 'Read the README', 'other', {
    description: 'Read the README',
    prompt: 'Report the first line of README.md',
    agent_type: 'explore',
    name: 'reader',
  });
  server.notify('session/update', {
    sessionId: 'native',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_8',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '# conformance scratch' } }],
    },
  });
  await flush();
  expect(events.find((event) => event.type === 'item.started')).toMatchObject({
    item: { id: 'call_8', type: 'subagent', title: 'Read the README' },
  });
  expect(events.find((event) => event.type === 'item.completed')).toMatchObject({
    item: { id: 'call_8', type: 'subagent', status: 'completed' },
  });
});
