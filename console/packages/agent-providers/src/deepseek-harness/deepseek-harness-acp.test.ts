import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import type * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import type * as ProviderProcess from '../provider-process';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, realpath: async (path: string) => path };
});
const servers: FakeAppServer[] = [];
const spawned: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
const homed = (home: string) => ({ HOME: home, USERPROFILE: home });
const MODEL = '["deepseek-official","deepseek-v4-flash"]';
const PRO = '["deepseek-official","deepseek-v4-pro"]';
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: { env: Record<string, string> }) => {
    spawned.push({ command, args, env: options.env });
    const server = new FakeAppServer();
    // What `dsh --profile acp` 0.2.1-rc.5 answers: no auth methods whether or
    // not a key is set, resume without load, and its routes as a grouped
    // `model` select whose values are [provider, model] pairs.
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
    const configOptions = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: MODEL,
        options: [
          {
            group: 'deepseek-official',
            name: 'DeepSeek',
            options: [
              { value: MODEL, name: 'deepseek-v4-flash' },
              { value: PRO, name: 'deepseek-v4-pro' },
            ],
          },
        ],
      },
      { id: 'reasoning_effort', type: 'select', currentValue: 'high', options: [] },
    ];
    server.replyAlways('session/new', () => ({ sessionId: 'native', configOptions }));
    server.replyAlways('session/resume', () => ({ configOptions }));
    server.replyAlways('session/set_config_option', () => ({ configOptions }));
    servers.push(server);
    return server;
  },
}));
const { installed, versionChecks } = vi.hoisted(() => ({
  installed: { version: '0.2.1-rc.5' },
  versionChecks: [] as string[],
}));
vi.mock('../provider-process', async (original) => ({
  ...(await original<typeof ProviderProcess>()),
  execProvider: async (command: string, args: string[]) => {
    versionChecks.push([command, ...args].join(' '));
    return { stdout: `${installed.version}\n`, stderr: '' };
  },
}));
const {
  checkDshSignIn,
  createDeepseekHarnessAdapter,
  deepseekHarnessAcp,
  dshHome,
  DSH_ASK_GATE,
  DSH_SETTINGS_PATCH,
} = await import('./deepseek-harness-acp');

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
  versionChecks.length = 0;
  installed.version = '0.2.1-rc.5';
});

const KEY = 'sk-placeholder';
async function dir(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), text, { mode: 0o600 });
  }
  return root;
}

type Mode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access';
async function start(input: { runtimeMode?: Mode; model?: string; resume?: string } = {}) {
  const adapter = createDeepseekHarnessAdapter({ binaryPath: '/bin/dsh' });
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: input.runtimeMode ?? 'approval-required',
    env: homed(await dir()),
    mcpServers: {},
    connectorMcpServers: [],
    ...(input.model ? { model: { id: input.model } } : {}),
    ...(input.resume ? { resume: { nativeSessionId: input.resume } } : {}),
  });
  return { adapter, events, server: servers.at(-1)! };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const update = (server: FakeAppServer, change: Record<string, unknown>) =>
  server.send({ method: 'session/update', params: { sessionId: 'native', update: change } });
const toolCall = (toolCallId: string, title: string, rawInput: Record<string, unknown>) => ({
  sessionUpdate: 'tool_call',
  toolCallId,
  title,
  kind: 'other',
  status: 'in_progress',
  rawInput,
});
// The only shape its permission requests take: the call id, allow once, reject.
const permission = (id: number, toolCallId: string) => ({
  id,
  method: 'session/request_permission',
  params: {
    sessionId: 'native',
    toolCall: { toolCallId },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  },
});
const launch = (home: string, runtimeMode?: Mode, cwd = '/work') =>
  deepseekHarnessAcp.launch({ binaryPath: '/bin/dsh', cwd, env: homed(home), runtimeMode });
const gatePlugin = async (patch: string) =>
  fileURLToPath(JSON.parse(/name: (".+")/.exec(await readFile(patch, 'utf8'))![1]!) as string);

it('launches the ACP profile in workspace-write, gated unless the session is in full access', async () => {
  const home = await dir();
  const env = {
    ...homed(home),
    DSH_PERMISSION_MODE: 'workspace-write',
    DSH_TELEMETRY_DISABLED: '1',
  };
  const full = await launch(home, 'full-access');
  expect({ ...full, args: full.args.slice(0, 3) }).toEqual({
    command: '/bin/dsh',
    args: ['--profile', 'acp', '--patch'],
    env,
  });
  // Background commands are off, as a cancelled turn would leave them running.
  expect(full.args).toHaveLength(4);
  expect(await readFile(full.args[3]!, 'utf8')).toBe(DSH_SETTINGS_PATCH);
  expect(versionChecks).toEqual([]);
  for (const mode of ['approval-required', 'auto-accept-edits', 'auto', undefined] as const) {
    const gated = await launch(home, mode);
    expect(gated.env).toEqual(env);
    expect(gated.args.slice(0, 4)).toEqual(['--profile', 'acp', '--patch', full.args[3]]);
    expect(gated.args[4]).toBe('--patch');
    const patch = gated.args[5]!;
    expect(patch.startsWith(join(home, '.local', 'state', 'switch', 'deepseek-harness'))).toBe(
      true
    );
    // The ACP bridge waits for the gate's service, so dsh cannot answer without it.
    expect(await readFile(patch, 'utf8')).toContain(
      '- id: acp\n  inject: [acpAppStartup, switchAskGate]\n'
    );
    expect(await readFile(await gatePlugin(patch), 'utf8')).toBe(DSH_ASK_GATE);
  }
  expect(versionChecks).toEqual(Array(4).fill('/bin/dsh --version'));
  expect(deepseekHarnessAcp.inheritEnv).toEqual([
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_BASE_URL',
    'DSH_HOME',
  ]);
  expect(deepseekHarnessAcp.unsupportedPlatforms?.win32).toContain('not been verified');
});

it('keeps its state private, quotes the plugin path, and leaves no older gate behind', async () => {
  const home = await dir();
  const state = join(home, '.local', 'state', 'switch', 'deepseek-harness');
  await mkdir(state, { recursive: true, mode: 0o755 });
  await writeFile(join(state, 'ask-gate-000000000000.mjs'), 'old');
  await chmod(state, 0o755);
  const quoted = join(home, "it's");
  await mkdir(quoted);
  const patch = (await launch(quoted)).args.at(-1)!;
  expect(await gatePlugin(patch)).toContain("it's");
  const launched = (await launch(home)).args;
  const fresh = launched.at(-1)!;
  if (process.platform !== 'win32') {
    expect(((await stat(state)).mode & 0o777).toString(8)).toBe('700');
    expect(((await stat(fresh)).mode & 0o777).toString(8)).toBe('600');
  }
  expect((await readdir(state)).sort()).toEqual(
    [basename(await gatePlugin(fresh)), basename(fresh), basename(launched[3]!)].sort()
  );
});

it('refuses a gated launch on a dsh version the gate is not verified with', async () => {
  installed.version = '0.2.2-rc.1';
  await expect(launch(await dir(), 'approval-required')).rejects.toThrow(
    "Switch's approval gate is verified with DeepSeek Harness 0.2.1-rc.5, not 0.2.2-rc.1. Install it (npm install -g @deepseek-ai/dsh@0.2.1-rc.5), or run this agent with bypass permissions."
  );
  expect((await launch(await dir(), 'full-access')).args).toHaveLength(4);
});

it("refuses auto-accept-edits where the agent's directory holds dsh's own settings", async () => {
  const home = await dir();
  await expect(launch(home, 'auto-accept-edits', home)).rejects.toThrow(
    "DeepSeek Harness's own settings are inside this agent's directory"
  );
  expect((await launch(home, 'approval-required', home)).args[2]).toBe('--patch');
  expect((await launch(home, 'auto-accept-edits', join(home, 'project'))).args[2]).toBe('--patch');
});

it('stops a session whose gate did not load, saying it would have run without asking', async () => {
  const { rejectOutputLine } = await launch(await dir(), 'approval-required');
  expect(
    rejectOutputLine?.(
      'dsh: startup failed: 1 required plugin did not activate\n\nFailed plugins (1):\n  switch-ask-gate\n'
    )
  ).toBe(
    "DeepSeek Harness did not load Switch's approval gate, so the session was not started; it would have run without asking. Run this agent with bypass permissions, or reinstall DeepSeek Harness 0.2.1-rc.5."
  );
  expect(rejectOutputLine?.('dsh: warning: 2 entries did not activate')).toBeUndefined();
});

it('asks for every tool but those that only read, telling a subagent why it cannot', async () => {
  const gate = (await import(await gatePlugin((await launch(await dir())).args.at(-1)!))) as {
    name: string;
    inject: string[];
    apply(ctx: unknown): void;
  };
  type Listener = (
    exec: { name: string; agent?: { session: string } },
    next: () => Promise<{ kind: string }>
  ) => Promise<unknown>;
  const listeners = new Map<string, Listener>();
  const provided: string[] = [];
  gate.apply({
    on: (event: string, listener: Listener) => listeners.set(event, listener),
    provide: (service: string) => provided.push(service),
    approval: { overrideOf: (session: string) => (session === 'child' ? 'never' : undefined) },
  });
  expect([gate.name, gate.inject, provided]).toEqual([
    'switch-ask-gate',
    ['tools', 'approval'],
    ['switchAskGate'],
  ]);
  const decide = listeners.get('tools/pre-execute')!;
  const allow = async () => ({ kind: 'allow' });
  const root = { session: 'root' };
  for (const name of [
    'bash',
    'pwsh',
    'write',
    'edit',
    'run_code',
    'workflow',
    'web_fetch',
    'web_search',
    'job_kill',
    'create_goal',
    'read_mcp_resource',
    'mcp__switch__post_message',
    'bash_persistent',
  ])
    expect(await decide({ name, agent: root }, allow)).toEqual({
      kind: 'ask',
      reason: `Switch asks before ${name} runs`,
    });
  for (const name of ['read', 'read_image', 'glob', 'grep', 'todo_write', 'skill', 'subagent'])
    expect(await decide({ name, agent: root }, allow)).toEqual({ kind: 'allow' });
  expect(await decide({ name: 'bash', agent: { session: 'child' } }, allow)).toEqual({
    kind: 'deny',
    reason:
      'Switch cannot ask for approval inside a DeepSeek Harness subagent outside full access; do this in the main agent instead.',
  });
  expect(await decide({ name: 'read', agent: { session: 'child' } }, allow)).toEqual({
    kind: 'allow',
  });
  expect(await decide({ name: 'bash', agent: root }, async () => ({ kind: 'deny' }))).toEqual({
    kind: 'deny',
  });
});

it('finds its home where the harness does', () => {
  expect(dshHome(homed('/h'), '/work')).toBe(join('/h', '.dsh'));
  expect(dshHome({ ...homed('/h'), DSH_HOME: '  ' }, '/work')).toBe(join('/h', '.dsh'));
  expect(dshHome({ ...homed('/h'), DSH_HOME: '~/harness' }, '/work')).toBe(join('/h', 'harness'));
  expect(dshHome({ ...homed('/h'), DSH_HOME: '/srv/dsh' }, '/work')).toBe(resolve('/srv/dsh'));
  expect(dshHome({ ...homed('/h'), DSH_HOME: 'state/dsh' }, '/work')).toBe(
    resolve('/work', 'state/dsh')
  );
});

it('is signed out with no key anywhere, saying how to sign in', async () => {
  const home = await dir({ '.dsh/.credentials.yaml': 'version: 1\nrefs:\n  OPENAI_API_KEY: x\n' });
  expect(await checkDshSignIn({ cwd: await dir(), env: homed(home) })).toEqual({
    status: 'unauthenticated',
    message:
      'DeepSeek Harness has no DeepSeek API key. Sign in on the execution machine with dsh web. Save a DeepSeek API key under its Models settings, or set DEEPSEEK_API_KEY.',
    models: [],
  });
});

it('is signed in with a key from each place the harness reads one, never reading it out', async () => {
  const saved = await dir({
    '.dsh/.credentials.yaml': `version: 1\n\n# saved from the Models page\nrefs:\n  DEEPSEEK_API_KEY: ${KEY}\n`,
  });
  const flow = await dir({ '.dsh/.credentials.yaml': `refs: { "DEEPSEEK_API_KEY": "${KEY}" }\n` });
  const block = await dir({
    '.dsh/.credentials.yaml': `refs:\n  DEEPSEEK_API_KEY: |\n    ${KEY}\n`,
  });
  const homeEnv = await dir({ '.dsh/.env': `export DEEPSEEK_API_KEY=${KEY}\n` });
  const project = await dir({ '.env': `OTHER=1\nDEEPSEEK_API_KEY="${KEY}"\n` });
  const empty = await dir();
  for (const [cwd, env, where] of [
    [empty, homed(saved), 'its saved credentials'],
    [empty, homed(flow), 'its saved credentials'],
    [empty, homed(block), 'its saved credentials'],
    [empty, { ...homed(empty), DEEPSEEK_API_KEY: KEY }, 'DEEPSEEK_API_KEY'],
    [project, homed(empty), "the project's .env"],
    [empty, homed(homeEnv), "the harness home's .env"],
    [empty, { ...homed('/nowhere'), DSH_HOME: join(saved, '.dsh') }, 'its saved credentials'],
  ] as const) {
    const result = await checkDshSignIn({ cwd, env });
    expect(result).toMatchObject({
      status: 'authenticated',
      message: `Signs in with the DeepSeek API key in ${where}; the first turn checks it.`,
    });
    expect(result.message).not.toContain(KEY);
  }
});

it('takes no empty key, nor one outside refs, for a sign-in', async () => {
  expect(
    await checkDshSignIn({
      cwd: await dir({ '.env': 'DEEPSEEK_API_KEY=\nDEEPSEEK_API_KEY=""\n' }),
      env: {
        ...homed(
          await dir({
            '.dsh/.credentials.yaml':
              'records:\n  llm-pi-ai/x:\n    kind: api-key\n    env:\n      DEEPSEEK_API_KEY: sk-x\n',
          })
        ),
        DEEPSEEK_API_KEY: ' ',
      },
    })
  ).toMatchObject({ status: 'unauthenticated' });
});

it('says so when the harness would refuse its saved credentials, rather than signed in or out', async () => {
  for (const [text, reason] of [
    ['refs: [unclosed\n', 'it is not valid YAML'],
    [`refs:\n  DEEPSEEK_API_KEY: ${KEY}\n  DEEPSEEK_API_KEY: ${KEY}\n`, 'it is not valid YAML'],
    ['refs:\n  DEEPSEEK_API_KEY: ""\n', 'a saved key is empty or not text'],
    ['refs:\n  DEEPSEEK_API_KEY:\n', 'a saved key is empty or not text'],
    ['- a list\n', 'it is not a mapping'],
  ] as const) {
    const result = await checkDshSignIn({
      cwd: await dir(),
      env: homed(await dir({ '.dsh/.credentials.yaml': text })),
    });
    expect(result.status).toBe('unknown');
    expect(result.message).toContain(reason);
  }
  if (process.platform !== 'win32') {
    const shared = await dir({ '.dsh/.credentials.yaml': `refs:\n  DEEPSEEK_API_KEY: ${KEY}\n` });
    await chmod(join(shared, '.dsh', '.credentials.yaml'), 0o644);
    expect(await checkDshSignIn({ cwd: await dir(), env: homed(shared) })).toMatchObject({
      status: 'unknown',
      message: expect.stringContaining('Run chmod 600 on it.'),
    });
  }
});

it('cannot vouch for a DeepSeek account sign-in alone, which the default route does not use', async () => {
  const home = await dir({
    '.dsh/.credentials.yaml':
      'version: 1\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n    payload: {}\n',
  });
  expect(await checkDshSignIn({ cwd: await dir(), env: homed(home) })).toMatchObject({
    status: 'unknown',
  });
});

it('reports saved credentials it cannot read rather than calling the CLI signed out', async () => {
  const home = await dir();
  await mkdir(join(home, '.dsh', '.credentials.yaml'), { recursive: true });
  await expect(checkDshSignIn({ cwd: await dir(), env: homed(home) })).rejects.toThrow('EISDIR');
});

it('checks sign-in without starting the agent, which would create its profile', async () => {
  const runtime = (await import('../providers/registry')).providerRuntime('deepseek-harness');
  await runtime.checkSignIn({
    binaryPath: '/bin/dsh',
    cwd: await dir(),
    env: homed(await dir()),
  });
  expect(spawned).toEqual([]);
});

it('starts without authenticate or set_mode, listing its routes and choosing one by config option', async () => {
  const { adapter, server } = await start({ model: PRO, runtimeMode: 'full-access' });
  expect(spawned[0]?.command).toBe('/bin/dsh');
  expect(spawned[0]?.args.slice(0, 3)).toEqual(['--profile', 'acp', '--patch']);
  expect(server.received.map((m) => m.method)).toEqual([
    'initialize',
    'session/new',
    'session/set_config_option',
  ]);
  expect(server.received.at(-1)?.params).toEqual({
    sessionId: 'native',
    configId: 'model',
    value: PRO,
  });
  expect((await adapter.listModels('s')).map(({ id, label }) => ({ id, label }))).toEqual([
    { id: MODEL, label: 'deepseek-v4-flash' },
    { id: PRO, label: 'deepseek-v4-pro' },
  ]);
  await adapter.stopAll();
});

it('resumes a saved conversation with session/resume', async () => {
  const { adapter } = await start({ resume: 'saved' });
  expect(servers.at(-1)!.received.find((m) => m.method === 'session/resume')?.params).toMatchObject(
    { sessionId: 'saved', cwd: '/work' }
  );
  await adapter.stopAll();
});

it('types and titles its tools, which it reports as kind other named by the tool', () => {
  const call = (title: string, rawInput: Record<string, unknown> = {}) => ({
    toolCallId: 'c',
    title,
    kind: 'other',
    rawInput,
  });
  const { itemType, toolTitle, mcpServerOf } = deepseekHarnessAcp;
  expect(itemType?.(call('bash'))).toBe('command_execution');
  expect(itemType?.(call('pwsh'))).toBe('command_execution');
  expect(itemType?.(call('write'))).toBe('file_change');
  expect(itemType?.(call('edit', { sandbox_permissions: 'workspace-write' }))).toBe('file_change');
  expect(itemType?.(call('write', { sandbox_permissions: 'danger-full-access' }))).toBe(
    'tool_call'
  );
  expect(itemType?.(call('subagent'))).toBe('subagent');
  expect(itemType?.(call('subagent_fork'))).toBe('subagent');
  expect(itemType?.(call('read'))).toBeUndefined();
  expect(toolTitle?.(call('bash', { description: 'Run it', command: 'npm  test' }))).toBe(
    'npm test'
  );
  expect(toolTitle?.(call('write', { file_path: '/work/a.txt', content: 'x' }))).toBe(
    'write /work/a.txt'
  );
  expect(toolTitle?.(call('subagent', { description: 'Read the readme', prompt: 'p' }))).toBe(
    'Read the readme'
  );
  expect(toolTitle?.(call('bash'))).toBeUndefined();
  expect(toolTitle?.(call('grep', { pattern: 'x' }))).toBeUndefined();
  expect(mcpServerOf?.(call('mcp__switch__send_message'), new Set())).toBe('switch');
  expect(mcpServerOf?.(call('mcp__my-server_2__echo'), new Set())).toBe('my-server_2');
  // A server or tool name with `__` in it is ambiguous, so it names no server and asks.
  expect(mcpServerOf?.(call('mcp__switch__x__tool'), new Set())).toBeUndefined();
  expect(mcpServerOf?.(call('mcp__switch__x__'), new Set())).toBeUndefined();
  expect(mcpServerOf?.(call('bash'), new Set())).toBeUndefined();
});

it("asks before a command by the call it announced, answering with the agent's options", async () => {
  const { adapter, events, server } = await start();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  update(server, toolCall('call-1', 'bash', { description: 'Show the date', command: 'date' }));
  server.send(permission(70, 'call-1'));
  await flush();
  const opened = events.find((e) => e.type === 'request.opened');
  if (opened?.type !== 'request.opened') throw new Error('No approval');
  expect(opened).toMatchObject({ requestType: 'command_execution_approval', title: 'date' });
  expect(opened.options.map((o) => o.decision)).toEqual(['accept', 'decline', 'cancel']);
  await adapter.respondToRequest('s', opened.requestId, 'decline');
  await flush();
  expect(server.received.find((m) => m.id === 70)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  });
  await adapter.stopAll();
});

it('allows workspace edits in auto-accept-edits, and asks for commands and wider writes', async () => {
  const { adapter, events, server } = await start({ runtimeMode: 'auto-accept-edits' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  update(server, toolCall('edit', 'write', { file_path: '/work/a.txt', content: 'x' }));
  update(server, toolCall('cmd', 'bash', { description: 'Show the date', command: 'date' }));
  update(
    server,
    toolCall('wide', 'write', {
      file_path: '/home/someone/.bashrc',
      content: 'x',
      sandbox_permissions: 'danger-full-access',
      justification: 'Outside the workspace.',
    })
  );
  for (const [id, call] of [
    [80, 'edit'],
    [81, 'cmd'],
    [82, 'wide'],
  ] as const)
    server.send(permission(id, call));
  await flush();
  expect(server.received.find((m) => m.id === 80)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  });
  expect(
    events.flatMap((e) => (e.type === 'request.opened' ? [[e.requestType, e.title]] : []))
  ).toEqual([
    ['command_execution_approval', 'date'],
    ['tool_approval', 'write /home/someone/.bashrc'],
  ]);
  await adapter.stopAll();
});

it('allows every request in full access without asking', async () => {
  const { adapter, events, server } = await start({ runtimeMode: 'full-access' });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  update(server, toolCall('call-2', 'write', { file_path: '/elsewhere/a.txt', content: 'x' }));
  server.send(permission(71, 'call-2'));
  await flush();
  expect(events.filter((e) => e.type === 'request.opened')).toEqual([]);
  expect(server.received.find((m) => m.id === 71)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  });
  await adapter.stopAll();
});

it("allows Switch's own MCP tools unasked, and asks for a connector's", async () => {
  const adapter = createDeepseekHarnessAdapter({ binaryPath: '/bin/dsh' });
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const http = { transport: 'http' as const, url: 'http://127.0.0.1:1/mcp' };
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'auto',
    env: homed(await dir()),
    mcpServers: { switch: http, github: http },
    connectorMcpServers: ['github'],
  });
  const server = servers.at(-1)!;
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  update(server, toolCall('own', 'mcp__switch__post_message', { body: 'hi' }));
  update(server, toolCall('vendor', 'mcp__github__merge_pull_request', { number: 1 }));
  update(server, toolCall('tricky', 'mcp__switch__x__tool', {}));
  server.send(permission(90, 'own'));
  server.send(permission(91, 'vendor'));
  server.send(permission(92, 'tricky'));
  await flush();
  expect(server.received.find((m) => m.id === 90)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  });
  expect(events.filter((e) => e.type === 'request.opened')).toMatchObject([
    { requestType: 'mcp_tool_approval', connector: 'github' },
    { requestType: 'tool_approval', title: 'mcp__switch__x__tool' },
  ]);
  await adapter.stopAll();
});

it('shows MCP calls and subagents as such on the activity card', async () => {
  const { adapter, events, server } = await start();
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  update(server, toolCall('m', 'mcp__switch__send_message', { text: 'hi' }));
  update(server, toolCall('a', 'subagent', { description: 'Read the readme', prompt: 'p' }));
  for (const id of ['m', 'a'])
    update(server, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' });
  await flush();
  expect(
    events
      .filter((e) => e.type === 'item.completed')
      .map((e) => (e.type === 'item.completed' ? [e.item.type, e.item.title] : []))
  ).toEqual([
    ['mcp_tool_call', 'mcp__switch__send_message'],
    ['subagent', 'Read the readme'],
  ]);
  await adapter.stopAll();
});
