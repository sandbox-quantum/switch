import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  mkdir: async () => undefined,
  writeFile: async () => undefined,
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
const preflight = vi.hoisted(() => vi.fn());
vi.mock('./launcher', () => ({
  preflightOpenHands: preflight,
  launchOpenHands: ({ binaryPath, env }: { binaryPath: string; env: Record<string, string> }) => ({
    command: binaryPath,
    args: ['acp'],
    env,
  }),
}));
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    // What the OpenHands ACP server (CLI 1.16) actually answers: a Cloud
    // auth method whether or not it is in use, loadable sessions, MCP over
    // HTTP and SSE — and, from `session/new`, modes but no models and no
    // config options.
    server.replyAlways('initialize', () => ({
      authMethods: [{ id: 'oauth', name: 'OAuth with OpenHands Cloud' }],
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: { image: true, embeddedContext: true },
      },
    }));
    const modes = {
      availableModes: [
        { id: 'always-ask', name: 'Always Ask' },
        { id: 'always-approve', name: 'Always Approve' },
        { id: 'llm-approve', name: 'LLM Approve' },
      ],
      currentModeId: 'always-ask',
    };
    server.replyAlways('session/new', () => ({ sessionId: 'native', modes }));
    server.replyAlways('session/load', () => ({ modes }));
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { createOpenHandsAdapter, openhandsAcp, openhandsHome, openhandsSignedIn } =
  await import('./openhands-adapter');
beforeEach(() => {
  servers.length = 0;
  preflight.mockReset().mockResolvedValue(undefined);
});
async function setup(
  resume = false,
  runtimeMode: 'approval-required' | 'full-access' = 'approval-required'
) {
  const adapter = createOpenHandsAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode,
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
    ...(resume ? { resume: { nativeSessionId: 'native' } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}
afterEach(() => {
  for (const server of servers) server.kill();
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

it('maps Switch runtime modes onto the OpenHands confirmation modes', () => {
  expect(openhandsAcp.sessionMode?.('approval-required', undefined)).toBe('always-ask');
  expect(openhandsAcp.sessionMode?.('auto-accept-edits', undefined)).toBe('always-ask');
  expect(openhandsAcp.sessionMode?.('auto', undefined)).toBe('llm-approve');
  expect(openhandsAcp.sessionMode?.('full-access', undefined)).toBe('always-approve');
});

it('starts a session without authenticating, and sets its confirmation mode', async () => {
  const { server, session } = await setup();
  expect(session.nativeSessionId).toBe('native');
  // No `authenticate`: the method OpenHands offers signs in to OpenHands
  // Cloud through a browser, and a local session runs on the configured
  // LLM, not on that sign-in.
  expect(server.received.map((m) => m.method)).toEqual([
    'initialize',
    'session/new',
    'session/set_mode',
  ]);
  expect(server.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
    sessionId: 'native',
    modeId: 'always-ask',
  });
});

it('passes MCP servers through the host bridge without putting credentials in arguments', async () => {
  const adapter = createOpenHandsAdapter({
    mcpBridge: { command: '/host/node', args: ['/host/sidecar.mjs', '--mcp-bridge'] },
  });
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {
      switch: {
        transport: 'http',
        url: 'http://127.0.0.1:9999/mcp',
        headers: { authorization: 'secret' },
      },
    },
    connectorMcpServers: [],
  });
  const request = servers.at(-1)!.received.find((message) => message.method === 'session/new');
  const mapped = request?.params?.mcpServers as Array<{
    name: string;
    args: string[];
    env: Array<{ name: string; value: string }>;
  }>;
  expect(mapped).toHaveLength(1);
  expect(mapped[0].name).toBe('switch');
  expect(mapped[0].args).toEqual(['/host/sidecar.mjs', '--mcp-bridge', 'openhands']);
  expect(JSON.stringify(mapped[0].args)).not.toContain('secret');
  const config = mapped[0].env.find((entry) => entry.name === 'SWITCH_OPENHANDS_MCP_SPEC');
  expect(JSON.parse(config!.value).headers.authorization).toBe('secret');
  await adapter.stopAll();
});

it('fails closed when a host starts OpenHands with MCP but no bridge entrypoint', async () => {
  const adapter = createOpenHandsAdapter();
  await expect(
    adapter.startSession({
      sessionId: 'no-bridge',
      cwd: '/work',
      runtimeMode: 'approval-required',
      env: {},
      mcpServers: { switch: { transport: 'http', url: 'http://127.0.0.1:9999/mcp' } },
      connectorMcpServers: [],
    })
  ).rejects.toThrow('OpenHands MCP requires the Switch host MCP bridge.');
  expect(servers.at(-1)!.received.some((message) => message.method === 'session/new')).toBe(false);
  await adapter.stopAll();
});

it('puts a full-access session in always-approve, so nothing asks', async () => {
  const { server } = await setup(false, 'full-access');
  expect(server.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
    sessionId: 'native',
    modeId: 'always-approve',
  });
});

it('resumes the stored conversation with session/load', async () => {
  const { server, session } = await setup(true);
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'native',
  });
  expect(server.received.some((m) => m.method === 'session/new')).toBe(false);
});

async function confirmationTurn(decision: 'accept' | 'decline') {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'edit a file' });
  server.send({
    id: 99,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'tool', kind: 'edit', title: 'Edit marker' },
      // The two options the CLI's confirmation policy offers (1.16).
      options: [
        { optionId: 'Confirm', name: 'Confirm', kind: 'allow_once' },
        { optionId: 'Deny', name: 'Deny', kind: 'reject_once' },
      ],
    },
  });
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  await adapter.respondToRequest('s', request.requestId, decision);
  await flush();
  return server.received.find((m) => m.id === 99)?.result;
}

it('answers a confirmation with the Confirm option the CLI offered', async () => {
  expect(await confirmationTurn('accept')).toEqual({
    outcome: { outcome: 'selected', optionId: 'Confirm' },
  });
});

it('answers a declined confirmation with the Deny option the CLI offered', async () => {
  expect(await confirmationTurn('decline')).toEqual({
    outcome: { outcome: 'selected', optionId: 'Deny' },
  });
});

it('interrupts the native turn and starts the queued one after it settles', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 'one', text: 'first' });
  await adapter.sendTurn({ sessionId: 's', turnId: 'two', text: 'second' });
  const prompt = await server.waitFor('session/prompt');
  await adapter.interruptTurn('s');
  await flush();
  expect(server.received.find((m) => m.method === 'session/cancel')?.params).toEqual({
    sessionId: 'native',
  });
  server.send({ id: prompt.id, result: { stopReason: 'cancelled' } });
  await flush();
  expect(events.find((e) => e.type === 'turn.completed')).toMatchObject({
    turnId: 'one',
    outcome: 'interrupted',
  });
  expect(server.received.filter((m) => m.method === 'session/prompt')).toHaveLength(2);
});

/** A directory fixture, with the files a test names written under it. */
function fixtureDir(base: string, files: Record<string, string>): string {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(base, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents);
  }
  return base;
}

/** A home directory fixture; the files a test names go in its `.openhands`. */
function fixtureHome(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), 'switch-openhands-test-'));
  fixtureDir(join(home, '.openhands'), files);
  return home;
}

const noHandshake = {
  binaryPath: 'openhands',
  cwd: '/work',
  // The check must not start an agent session or open the Cloud login.
  handshake: async (): Promise<never> => {
    throw new Error('the sign-in check must not run the agent');
  },
  request: async (): Promise<never> => {
    throw new Error('the sign-in check must not request the agent');
  },
};

it('resolves the home the CLI resolves', () => {
  expect(openhandsHome({ HOME: '/home/u' })).toBe('/home/u/.openhands');
  expect(openhandsHome({ HOME: '/home/u', OPENHANDS_PERSISTENCE_DIR: '/data/oh' })).toBe(
    '/data/oh'
  );
});

it('reports a configured agent as signed in', async () => {
  const home = fixtureHome({
    'agent_settings.json': JSON.stringify({ llm: { model: 'openai/gpt-5.2', api_key: 'sk-x' } }),
  });
  await expect(openhandsSignedIn({ HOME: home })).resolves.toBe(true);
  await expect(openhandsAcp.checkSignIn!({ ...noHandshake, env: { HOME: home } })).resolves.toEqual(
    { status: 'authenticated', message: 'Signed in.', models: [] }
  );
});

it('checks the selected installation before reporting a configured agent ready', async () => {
  const home = fixtureHome({ 'agent_settings.json': JSON.stringify({ llm: { model: 'test' } }) });
  const input = {
    ...noHandshake,
    binaryPath: '/chosen/openhands',
    cwd: '/chosen/work',
    env: { HOME: home, PATH: '/chosen/bin' },
  };
  await expect(openhandsAcp.checkSignIn!(input)).resolves.toMatchObject({
    status: 'authenticated',
  });
  expect(preflight).toHaveBeenCalledWith({
    binaryPath: input.binaryPath,
    cwd: input.cwd,
    env: input.env,
  });
});

it('reports incompatible installations with actionable, sanitized readiness', async () => {
  const home = fixtureHome({ 'agent_settings.json': JSON.stringify({ llm: { model: 'test' } }) });
  preflight.mockRejectedValue(new Error('sensitive path or secret'));
  const result = await openhandsAcp.checkSignIn!({ ...noHandshake, env: { HOME: home } });
  expect(result).toMatchObject({ status: 'unconfigured', loginHelps: false });
  expect(result.message).toContain('OpenHands CLI 1.16.0');
  expect(result.message).toContain('SDK/tools 1.21.0');
  expect(result.message).not.toContain('sensitive');
});

it('does not treat a Cloud login alone as a configured local agent', async () => {
  const home = fixtureHome({ 'cloud/api_key.txt': 'key\n' });
  await expect(openhandsSignedIn({ HOME: home })).resolves.toBe(false);
});

it('reports signed out when nothing is configured', async () => {
  const home = fixtureHome({});
  await expect(openhandsSignedIn({ HOME: home })).resolves.toBe(false);
  const result = await openhandsAcp.checkSignIn!({ ...noHandshake, env: { HOME: home } });
  expect(result.status).toBe('unauthenticated');
  expect(result.message).toContain('Run `openhands`');
});

it('does not take the CLI preferences file, or a model-less agent, as a sign-in', async () => {
  const preferencesOnly = fixtureHome({ 'cli_config.json': '{"max_iterations": 100}' });
  await expect(openhandsSignedIn({ HOME: preferencesOnly })).resolves.toBe(false);
  const noModel = fixtureHome({ 'agent_settings.json': JSON.stringify({ tools: [] }) });
  await expect(openhandsSignedIn({ HOME: noModel })).resolves.toBe(false);
  const corrupt = fixtureHome({ 'agent_settings.json': '{not json' });
  await expect(openhandsSignedIn({ HOME: corrupt })).resolves.toBe(false);
  const blankKey = fixtureHome({ 'cloud/api_key.txt': '  \n' });
  await expect(openhandsSignedIn({ HOME: blankKey })).resolves.toBe(false);
});

it('reads the home OPENHANDS_PERSISTENCE_DIR names, not the default', async () => {
  const elsewhere = fixtureDir(mkdtempSync(join(tmpdir(), 'switch-openhands-test-')), {
    'agent_settings.json': JSON.stringify({ llm: { model: 'anthropic/claude-sonnet-4-5' } }),
  });
  const home = fixtureHome({});
  await expect(
    openhandsSignedIn({ HOME: home, OPENHANDS_PERSISTENCE_DIR: elsewhere })
  ).resolves.toBe(true);
});
