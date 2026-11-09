import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
const spawned: Array<{ command: string; args: string[] }> = [];
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawned.push({ command, args });
    const server = new FakeAppServer();
    // What dsh-acp 0.2.2-rc.1 answers `initialize` with.
    server.replyAlways('initialize', () => ({
      protocolVersion: 1,
      agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
      agentCapabilities: {
        mcpCapabilities: { http: true },
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { close: {}, list: {}, resume: {} },
      },
      authMethods: [],
    }));
    const session = {
      sessionId: 'native',
      configOptions: [
        {
          id: 'model',
          type: 'select',
          currentValue: 'deepseek-v4-pro',
          options: [
            { value: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
            { value: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          ],
        },
      ],
    };
    server.replyAlways('session/new', () => session);
    server.replyAlways('session/resume', () => session);
    server.replyAlways('session/set_config_option', () => ({
      configOptions: session.configOptions,
    }));
    servers.push(server);
    return server;
  },
}));
const {
  checkDshSignIn,
  createDeepseekHarnessAdapter,
  credentialsHaveKey,
  deepseekHarnessAcp,
  dotenvHasKey,
  dshHome,
  dshItemType,
} = await import('./deepseek-harness-acp');

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
});

async function setup(
  options: {
    resume?: boolean;
    runtimeMode?: 'approval-required' | 'full-access' | 'auto-accept-edits' | 'auto';
  } = {}
) {
  const adapter = createDeepseekHarnessAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: options.runtimeMode ?? 'approval-required',
    env: {},
    mcpServers: {
      switch: { transport: 'http', url: 'http://127.0.0.1:4567/mcp', headers: {} },
    },
    connectorMcpServers: [],
    ...(options.resume ? { resume: { nativeSessionId: 'native' } } : {}),
  });
  return { adapter, events, server: servers.at(-1)!, session };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

it('runs dsh with its ACP profile and sends no authenticate', async () => {
  const { server, session } = await setup();
  expect(spawned.at(-1)).toEqual({ command: 'dsh', args: ['--profile', 'acp'] });
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  expect(server.received.some((m) => m.method === 'session/set_mode')).toBe(false);
});

it('registers HTTP MCP servers, which dsh advertises', async () => {
  const { server } = await setup();
  expect(server.received.find((m) => m.method === 'session/new')?.params).toMatchObject({
    cwd: '/work',
    mcpServers: [{ type: 'http', name: 'switch', url: 'http://127.0.0.1:4567/mcp' }],
  });
});

it('resumes a saved conversation with session/resume, dsh having no session/load', async () => {
  const { server, session } = await setup({ resume: true });
  expect(session.nativeSessionId).toBe('native');
  expect(server.received.some((m) => m.method === 'session/load')).toBe(false);
  expect(server.received.find((m) => m.method === 'session/resume')?.params).toMatchObject({
    sessionId: 'native',
    cwd: '/work',
  });
});

it('lists and selects models through its model config option', async () => {
  const { adapter, server } = await setup();
  expect((await adapter.listModels('s')).map((m) => m.id)).toEqual([
    'deepseek-v4-pro',
    'deepseek-v4-flash',
  ]);
  await adapter.setModel('s', { id: 'deepseek-v4-flash' });
  expect(server.received.find((m) => m.method === 'session/set_config_option')?.params).toEqual({
    sessionId: 'native',
    configId: 'model',
    value: 'deepseek-v4-flash',
  });
});

const permission = (server: FakeAppServer, id: number, kind: string) =>
  server.send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: `tool-${id}`, kind, title: 'Run tests' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });

it('asks for approval in approval-required mode, and can be denied', async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run the tests' });
  permission(server, 90, 'execute');
  await flush();
  const request = events.find((e) => e.type === 'request.opened');
  if (!request || request.type !== 'request.opened') throw new Error('missing approval');
  await adapter.respondToRequest('s', request.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'reject' },
  });
});

it('approves on its own in full-access mode, dsh having no modes', async () => {
  const { adapter, events, server } = await setup({ runtimeMode: 'full-access' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run the tests' });
  permission(server, 91, 'execute');
  await flush();
  expect(events.some((e) => e.type === 'request.opened')).toBe(false);
  expect(server.received.find((m) => m.id === 91)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow' },
  });
});

it('cancels the native turn on interrupt', async () => {
  const { adapter, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'long job' });
  await server.waitFor('session/prompt');
  await adapter.interruptTurn('s');
  await flush();
  expect(server.received.find((m) => m.method === 'session/cancel')?.params).toEqual({
    sessionId: 'native',
  });
});

describe('sign-in check', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-sign-in-'));
    await mkdir(join(root, 'home'));
    await mkdir(join(root, 'project'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const check = (env: Record<string, string> = {}) =>
    checkDshSignIn({
      cwd: join(root, 'project'),
      env: { DSH_HOME: join(root, 'home'), ...env },
    });

  it('reports signed out with a sign-in hint, and starts nothing', async () => {
    const result = await check();
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain('Sign in on the execution machine with dsh web.');
    expect(result.message).toContain('DEEPSEEK_API_KEY');
    expect(spawned).toEqual([]);
  });

  it('reads the key the Models page saves', async () => {
    await writeFile(
      join(root, 'home', '.credentials.yaml'),
      'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-synthetic\n'
    );
    expect((await check()).status).toBe('authenticated');
  });

  it('takes the key from the environment', async () => {
    expect((await check({ DEEPSEEK_API_KEY: 'sk-synthetic' })).status).toBe('authenticated');
    expect((await check({ DEEPSEEK_API_KEY: '  ' })).status).toBe('unauthenticated');
  });

  it('takes the key from the project .env or the dsh home .env', async () => {
    await writeFile(join(root, 'project', '.env'), 'DEEPSEEK_API_KEY=sk-synthetic\n');
    expect((await check()).status).toBe('authenticated');
    await rm(join(root, 'project', '.env'));
    await writeFile(join(root, 'home', '.env'), 'export DEEPSEEK_API_KEY="sk-synthetic"\n');
    expect((await check()).status).toBe('authenticated');
  });

  it('detects an OpenRouter environment key without exposing it', async () => {
    const result = await check({ OPENROUTER_API_KEY: 'synthetic-openrouter-secret' });
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('OPENROUTER_API_KEY');
    expect(result.message).toContain('have not been verified');
    expect(result.message).not.toContain('synthetic-openrouter-secret');
    expect(spawned).toEqual([]);
    expect((await check({ OPENROUTER_API_KEY: '  ' })).status).toBe('unauthenticated');
  });

  it('detects an OpenRouter credential reference without exposing it', async () => {
    await writeFile(
      join(root, 'home', '.credentials.yaml'),
      'version: 1\nrefs:\n  OPENROUTER_API_KEY: synthetic-saved-secret\n'
    );
    const result = await check();
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('OPENROUTER_API_KEY');
    expect(result.message).toContain('have not been verified');
    expect(result.message).not.toContain('synthetic-saved-secret');
  });

  it('detects OpenRouter keys in the project or dsh home dotenv', async () => {
    await writeFile(join(root, 'project', '.env'), 'OPENROUTER_API_KEY=synthetic-project-key\n');
    expect((await check()).status).toBe('unknown');
    await rm(join(root, 'project', '.env'));
    await writeFile(join(root, 'home', '.env'), 'export OPENROUTER_API_KEY="synthetic-home-key"\n');
    expect((await check()).status).toBe('unknown');
  });

  it('reports an unknown route when both DeepSeek and OpenRouter keys are present', async () => {
    await writeFile(
      join(root, 'home', '.credentials.yaml'),
      'version: 1\nrefs:\n  OPENROUTER_API_KEY: synthetic-router\n'
    );
    const result = await check({ DEEPSEEK_API_KEY: 'synthetic-deepseek' });
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('OPENROUTER_API_KEY');
    expect(result.message).not.toContain('synthetic-router');
    expect(result.message).not.toContain('synthetic-deepseek');
  });

  it('keeps DeepSeek-only detection when OpenRouter is empty', async () => {
    const result = await check({ DEEPSEEK_API_KEY: 'synthetic-deepseek', OPENROUTER_API_KEY: ' ' });
    expect(result.status).toBe('authenticated');
    expect(result.message).not.toContain('synthetic-deepseek');
  });

  it('does not treat comment-only or empty values as keys', async () => {
    await writeFile(
      join(root, 'home', '.credentials.yaml'),
      'refs:\n  OPENROUTER_API_KEY: # no key\n'
    );
    await writeFile(join(root, 'project', '.env'), 'OPENROUTER_API_KEY= # no key\n');
    expect((await check()).status).toBe('unauthenticated');
  });

  it('reports an unreadable credential document as unknown without exposing its content', async () => {
    await writeFile(
      join(root, 'home', '.credentials.yaml'),
      'refs: [unterminated synthetic-secret'
    );
    const result = await check({ DEEPSEEK_API_KEY: 'synthetic-env-secret' });
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('credential store');
    expect(result.message).not.toContain('synthetic');
  });

  it('is wired as the provider check without a handshake', async () => {
    const handshake = vi.fn();
    const result = await deepseekHarnessAcp.checkSignIn!({
      binaryPath: 'dsh',
      cwd: join(root, 'project'),
      env: { DSH_HOME: join(root, 'home') },
      handshake,
      request: vi.fn(),
    });
    expect(result.status).toBe('unauthenticated');
    expect(handshake).not.toHaveBeenCalled();
  });
});

it('parses only a non-empty key under refs', () => {
  expect(credentialsHaveKey('version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-x\n')).toBe(true);
  expect(credentialsHaveKey('version: 1\nrefs:\n  DEEPSEEK_API_KEY: ""\n')).toBe(false);
  expect(credentialsHaveKey('version: 1\nrecords:\n  DEEPSEEK_API_KEY: sk-x\n')).toBe(false);
  expect(credentialsHaveKey('version: 1\nrefs:\n  OTHER: sk-x\n')).toBe(false);
  expect(dotenvHasKey('DEEPSEEK_API_KEY=\n')).toBe(false);
  expect(dotenvHasKey("DEEPSEEK_API_KEY=''\n")).toBe(false);
  expect(dotenvHasKey('# DEEPSEEK_API_KEY=sk-x\n')).toBe(false);
  expect(dotenvHasKey('DEEPSEEK_API_KEY = sk-x\n')).toBe(true);
  expect(dotenvHasKey('OPENROUTER_API_KEY= # comment\n', 'OPENROUTER_API_KEY')).toBe(false);
  expect(dotenvHasKey('OPENROUTER_API_KEY=synthetic # comment\n', 'OPENROUTER_API_KEY')).toBe(true);
  expect(dotenvHasKey('OPENROUTER_API_KEY="#not-a-comment"\n', 'OPENROUTER_API_KEY')).toBe(true);
  expect(credentialsHaveKey('refs:\n  OPENROUTER_API_KEY: # comment\n', 'OPENROUTER_API_KEY')).toBe(
    false
  );
  expect(
    credentialsHaveKey('refs:\n  OPENROUTER_API_KEY: "" # comment\n', 'OPENROUTER_API_KEY')
  ).toBe(false);
  expect(
    credentialsHaveKey('refs:\n  OPENROUTER_API_KEY: synthetic # comment\n', 'OPENROUTER_API_KEY')
  ).toBe(true);
  expect(
    credentialsHaveKey('refs:\n  OTHER:\n    OPENROUTER_API_KEY: synthetic\n', 'OPENROUTER_API_KEY')
  ).toBe(false);
  expect(
    credentialsHaveKey('refs:\n  OPENROUTER_API_KEY: {nested: value}\n', 'OPENROUTER_API_KEY')
  ).toBe(false);

  expect(credentialsHaveKey('refs:\n  OPENROUTER_API_KEY: synthetic\n', 'OPENROUTER_API_KEY')).toBe(
    true
  );
  expect(credentialsHaveKey('refs:\n  OPENROUTER_API_KEY: null\n', 'OPENROUTER_API_KEY')).toBe(
    false
  );
  expect(
    credentialsHaveKey('records:\n  OPENROUTER_API_KEY: synthetic\n', 'OPENROUTER_API_KEY')
  ).toBe(false);
  expect(dotenvHasKey('OPENROUTER_API_KEY=""\n', 'OPENROUTER_API_KEY')).toBe(false);
  expect(dotenvHasKey('# OPENROUTER_API_KEY=synthetic\n', 'OPENROUTER_API_KEY')).toBe(false);
});

it('parses YAML scalars and refuses malformed or ambiguous credential documents', () => {
  expect(
    credentialsHaveKey('refs: { OPENROUTER_API_KEY: "synthetic" }', 'OPENROUTER_API_KEY')
  ).toBe(true);
  expect(credentialsHaveKey('refs:\n  OPENROUTER_API_KEY: 42', 'OPENROUTER_API_KEY')).toBe(false);
  expect(credentialsHaveKey('refs:\n  OPENROUTER_API_KEY: true', 'OPENROUTER_API_KEY')).toBe(false);
  expect(credentialsHaveKey('refs:\n  OPENROUTER_API_KEY: "42"', 'OPENROUTER_API_KEY')).toBe(true);
  expect(credentialsHaveKey('refs: [unterminated', 'OPENROUTER_API_KEY')).toBeUndefined();
  expect(
    credentialsHaveKey(
      'refs:\n  OPENROUTER_API_KEY: first\n  OPENROUTER_API_KEY: second',
      'OPENROUTER_API_KEY'
    )
  ).toBeUndefined();
});

it('types tool items by the tool name, dsh-acp reporting every kind as other', () => {
  expect(dshItemType({ title: 'bash' })).toBe('command_execution');
  expect(dshItemType({ title: 'write' })).toBe('file_change');
  expect(dshItemType({ title: 'edit' })).toBe('file_change');
  expect(dshItemType({ title: 'subagent' })).toBe('subagent');
  expect(dshItemType({ title: 'read' })).toBeUndefined();
});

it('resolves the dsh home as dsh does', () => {
  expect(dshHome({ DSH_HOME: '/opt/dsh' })).toBe('/opt/dsh');
  expect(dshHome({ HOME: '/home/me' })).toBe('/home/me/.dsh');
});
