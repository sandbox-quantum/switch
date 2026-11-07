import type * as fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeMode } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import type * as providerProcess from '../provider-process';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
vi.mock('../provider-process', async (original) => ({
  ...(await original<typeof providerProcess>()),
  execProvider: vi.fn(async () => ({ stdout: '{"stopped":true}', stderr: '' })),
}));
const spawned: Array<{ server: FakeAppServer; args: string[]; env: Record<string, string> }> = [];
/** Whether the fake agent has a saved sign-in. */
const agent = { signedIn: true };
vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[], options: { env: Record<string, string> }) => {
    const server = new FakeAppServer();
    // Cline 3.0.74 declares no `mcpCapabilities` and ignores the MCP servers
    // sent in `session/new`.
    server.replyAlways('initialize', () => ({ agentCapabilities: { loadSession: true } }));
    server.on('message', (message: { id?: number; method?: string }) => {
      if (message.method !== 'session/new' || message.id === undefined) return;
      server.send(
        agent.signedIn
          ? { id: message.id, result: { sessionId: 'native' } }
          : {
              id: message.id,
              error: {
                code: -32000,
                message: 'Authentication required: Call authenticate before starting a session',
              },
            }
      );
    });
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    spawned.push({ server, args, env: options.env });
    return server;
  },
}));
const {
  clineAcp,
  clineMcpServerOf,
  clineMcpSettings,
  clineProviderSettingsPath,
  createClineAdapter,
  parseClineSignIn,
} = await import('./cline-adapter');
const { execProvider } = await import('../provider-process');

const dirs: string[] = [];
beforeEach(() => {
  spawned.length = 0;
  agent.signedIn = true;
  vi.mocked(execProvider).mockClear();
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
const providersJson = (providers: Record<string, unknown>) =>
  JSON.stringify({ version: 1, providers });

async function setup(resume = false, runtimeMode: RuntimeMode = 'approval-required') {
  const adapter = createClineAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode,
    env: { PATH: '/bin', SWITCH_TOKEN: 'from-env' },
    mcpServers: {
      switch: {
        transport: 'http',
        url: 'http://127.0.0.1:4100/mcp',
        headers: { Authorization: 'Bearer synthetic' },
      },
      helper: {
        transport: 'stdio',
        command: 'node',
        args: ['helper.js'],
        env: { MODE: 'test' },
        envVars: ['SWITCH_TOKEN', 'MISSING'],
      },
    },
    connectorMcpServers: ['helper'],
    ...(resume ? { resume: { nativeSessionId: 'native' } } : {}),
  });
  return { adapter, events, session, ...spawned.at(-1)! };
}

it('starts `cline --acp` and hands it the session MCP servers through its own settings file', async () => {
  const { adapter, server, args, env, session } = await setup();
  expect(session.nativeSessionId).toBe('native');
  expect(args).toEqual(['--acp']);
  expect(server.received.find((m) => m.method === 'session/new')?.params).toMatchObject({
    mcpServers: [],
  });
  const path = env.CLINE_MCP_SETTINGS_PATH!;
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    mcpServers: {
      switch: {
        type: 'streamableHttp',
        url: 'http://127.0.0.1:4100/mcp',
        headers: { Authorization: 'Bearer synthetic' },
      },
      helper: {
        type: 'stdio',
        command: 'node',
        args: ['helper.js'],
        env: { SWITCH_TOKEN: 'from-env', MODE: 'test' },
      },
    },
  });
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  // A hub daemon of its own, found through a file in the same folder.
  expect(dirname(env.CLINE_HUB_DISCOVERY_PATH!)).toBe(dirname(path));
  await adapter.stopSession('s');
  await flush();
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  // A daemon killed before it wrote its discovery file would still be running,
  // so the stop is asked for whether or not that file exists.
  expect(execProvider).toHaveBeenCalledWith(
    expect.any(String),
    ['hub', 'stop'],
    expect.objectContaining({
      env: expect.objectContaining({ CLINE_HUB_DISCOVERY_PATH: expect.any(String) }),
    })
  );
});

it("stops the session's own Cline hub daemon when the session ends", async () => {
  const { adapter, env } = await setup();
  const hub = env.CLINE_HUB_DISCOVERY_PATH!;
  // The daemon `cline --acp` starts records itself here.
  await writeFile(hub, '{"pid":1}');
  await adapter.stopSession('s');
  expect(execProvider).toHaveBeenCalledWith(
    expect.any(String),
    ['hub', 'stop'],
    expect.objectContaining({ env: expect.objectContaining({ CLINE_HUB_DISCOVERY_PATH: hub }) })
  );
  await expect(stat(dirname(hub))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('still removes its files when `hub stop` fails', async () => {
  vi.mocked(execProvider).mockRejectedValueOnce(new Error('no hub'));
  const { adapter, env } = await setup();
  const dir = dirname(env.CLINE_MCP_SETTINGS_PATH!);
  await adapter.stopSession('s');
  await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('fails a signed-out start without opening a sign-in, and removes the settings file', async () => {
  agent.signedIn = false;
  const start = createClineAdapter().startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
  });
  await expect(start).rejects.toThrow(/Authentication required/);
  const { server, env } = spawned.at(-1)!;
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  await expect(stat(env.CLINE_MCP_SETTINGS_PATH!)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('resumes the exact native conversation and stays in act mode', async () => {
  const { server } = await setup(true);
  expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
    sessionId: 'native',
    mcpServers: [],
  });
  expect(server.received.find((m) => m.method === 'session/set_mode')?.params).toEqual({
    sessionId: 'native',
    modeId: 'act',
  });
  expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  for (const mode of ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const)
    expect(clineAcp.sessionMode?.(mode, undefined)).toBe('act');
});

it("allows the session's own MCP tools once, and asks for a connector's", async () => {
  const { adapter, events, server } = await setup();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'read the room' });
  const options = [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  ];
  server.send({
    id: 90,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'a', title: 'switch__read_history: {"limit":20}', kind: 'other' },
      options,
    },
  });
  await flush();
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
  server.send({
    id: 91,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: 'b', title: 'helper__lookup', kind: 'other' },
      options,
    },
  });
  await flush();
  expect(server.received.some((m) => m.id === 91)).toBe(false);
  expect(events.some((e) => e.type === 'request.opened')).toBe(true);
});

it('treats Cline’s edit and command tools as edits and commands, though it marks them `other`', async () => {
  const { adapter, events, server } = await setup(false, 'auto-accept-edits');
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'fix it' });
  const options = [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  ];
  const ask = (id: number, toolCallId: string, title: string) =>
    server.send({
      id,
      method: 'session/request_permission',
      params: { sessionId: 'native', toolCall: { toolCallId, title, kind: 'other' }, options },
    });
  for (const [id, title] of [
    ['p', 'apply_patch: {"input":"*** Begin Patch"}'],
    ['c', 'run_commands: npm test'],
  ] as const)
    server.send({
      method: 'session/update',
      params: {
        sessionId: 'native',
        update: { sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'other' },
      },
    });
  await flush();
  expect(
    events.flatMap((e) => (e.type === 'item.started' ? [[e.item.id, e.item.type]] : []))
  ).toEqual([
    ['p', 'file_change'],
    ['c', 'command_execution'],
  ]);
  // Edits go through in auto-accept-edits; a command still asks.
  ask(92, 'p', 'apply_patch: {"input":"*** Begin Patch"}');
  ask(93, 'c', 'run_commands: npm test');
  await flush();
  expect(server.received.find((m) => m.id === 92)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
  expect(server.received.some((m) => m.id === 93)).toBe(false);
  expect(events.find((e) => e.type === 'request.opened')).toMatchObject({
    requestType: 'command_execution_approval',
  });
});

it('names the MCP server of a tool call and marks spawned agents as subagents', () => {
  expect(clineMcpServerOf({ toolCallId: '1', title: 'switch__send_message: hi' })).toBe('switch');
  expect(clineMcpServerOf({ toolCallId: '2', title: 'switch__list_members' })).toBe('switch');
  expect(clineMcpServerOf({ toolCallId: '3', title: 'run_commands: ls -la' })).toBeUndefined();
  expect(clineMcpServerOf({ toolCallId: '4' })).toBeUndefined();
  expect(clineAcp.itemType?.({ toolCallId: '5', title: 'spawn_agent: review' })).toBe('subagent');
  expect(clineAcp.itemType?.({ toolCallId: '6', title: 'editor: a.ts' })).toBeUndefined();
});

it('writes stdio and HTTP servers in the shape Cline reads', () => {
  expect(
    clineMcpSettings(
      {
        web: { transport: 'http', url: 'https://example.test/mcp' },
        local: {
          transport: 'stdio',
          command: 'tool',
          args: [],
          envVars: ['KEY'],
          env: { KEY: 'set' },
        },
      },
      { KEY: 'from-env' }
    )
  ).toEqual({
    mcpServers: {
      web: { type: 'streamableHttp', url: 'https://example.test/mcp', headers: {} },
      local: { type: 'stdio', command: 'tool', args: [], env: { KEY: 'set' } },
    },
  });
});

it('quotes a stdio command or argument with a space on Windows, where Cline uses the shell', () => {
  const server = {
    transport: 'stdio' as const,
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\My Tools\\server.mjs', '--port', '"already quoted"'],
  };
  expect(clineMcpSettings({ local: server }, {}, 'win32').mcpServers.local).toMatchObject({
    command: '"C:\\Program Files\\nodejs\\node.exe"',
    args: ['"C:\\My Tools\\server.mjs"', '--port', '"already quoted"'],
  });
  expect(clineMcpSettings({ local: server }, {}, 'linux').mcpServers.local).toMatchObject({
    command: server.command,
    args: server.args,
  });
});

it('finds the saved sign-in where Cline itself looks', () => {
  const home = join('/home', 'person');
  expect(clineProviderSettingsPath({ HOME: home })).toBe(
    join(home, '.cline', 'data', 'settings', 'providers.json')
  );
  expect(clineProviderSettingsPath({ HOME: home, CLINE_DIR: '/c' })).toBe(
    join('/c', 'data', 'settings', 'providers.json')
  );
  expect(clineProviderSettingsPath({ CLINE_DIR: '/c', CLINE_DATA_DIR: '/d' })).toBe(
    join('/d', 'settings', 'providers.json')
  );
  expect(
    clineProviderSettingsPath({ CLINE_DATA_DIR: '/d', CLINE_PROVIDER_SETTINGS_PATH: '/p.json' })
  ).toBe('/p.json');
});

it('counts only the sign-ins Cline uses over ACP', () => {
  const path = '/x/providers.json';
  expect(parseClineSignIn(undefined, path)).toMatchObject({
    status: 'unauthenticated',
    message: 'Sign in on the execution machine with cline auth.',
  });
  for (const [id, settings] of [
    ['cline', { auth: { accessToken: 'workos:synthetic' } }],
    ['cline-pass', { auth: { accessToken: 'synthetic' } }],
    ['openai-codex', { auth: { accessToken: 'synthetic' } }],
    ['cline', { apiKey: 'synthetic' }],
  ] as const)
    expect(parseClineSignIn(providersJson({ [id]: { settings } }), path).status).toBe(
      'authenticated'
    );
  expect(
    parseClineSignIn(
      providersJson({ anthropic: { settings: { apiKey: 'sk-ant-synthetic' } } }),
      path
    ).status
  ).toBe('unauthenticated');
  expect(
    parseClineSignIn(providersJson({ cline: { settings: { auth: { accessToken: '  ' } } } }), path)
      .status
  ).toBe('unauthenticated');
  expect(parseClineSignIn('{not json', path)).toMatchObject({
    status: 'unknown',
    message: expect.stringContaining(path),
  });
});

it('checks the sign-in from the saved file or an API key, without starting Cline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cline-sign-in-'));
  dirs.push(dir);
  const path = join(dir, 'providers.json');
  const handshake = vi.fn();
  const request = vi.fn();
  const connection = vi.fn();
  const check = (env: Record<string, string>) =>
    clineAcp.checkSignIn!({ binaryPath: 'cline', cwd: dir, env, handshake, request, connection });
  await expect(check({ CLINE_PROVIDER_SETTINGS_PATH: path })).resolves.toMatchObject({
    status: 'unauthenticated',
  });
  await writeFile(path, providersJson({ cline: { settings: { auth: { accessToken: 'x' } } } }));
  await expect(check({ CLINE_PROVIDER_SETTINGS_PATH: path })).resolves.toMatchObject({
    status: 'authenticated',
  });
  await expect(
    check({ CLINE_API_KEY: 'synthetic', CLINE_PROVIDER_SETTINGS_PATH: '/none' })
  ).resolves.toMatchObject({
    status: 'authenticated',
  });
  expect(handshake).not.toHaveBeenCalled();
  expect(spawned).toHaveLength(0);
});
