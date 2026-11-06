import type * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    server.replyAlways('initialize', () => ({ agentCapabilities: { loadSession: true } }));
    server.replyAlways('session/new', () => ({
      sessionId: 'native',
      modes: {
        currentModeId: 'default',
        availableModes: ['default', 'plan', 'auto', 'yolo'].map((id) => ({ id, name: id })),
      },
    }));
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { checkKimiSignIn, createKimiAdapter, kimiAcp } = await import('./kimi-acp');

beforeEach(() => {
  servers.length = 0;
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A Kimi home holding `files`, relative path → content. */
async function home(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-home-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

const FRESH_CONFIG = '# Kimi Code\n# configuration\n# see the docs\n# for more\n';
const oauthConfig = (apiKey: string) => `default_model = "kimi-code/kimi-for-coding"
[providers."managed:kimi-code"]
type = "kimi"
api_key = "${apiKey}"
base_url = "https://example.invalid/coding/v1"
[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-0123456789abcdef"
[services.moonshot_search]
api_key = "not-a-provider"
`;
const CREDENTIAL = 'credentials/kimi-code-env-0123456789abcdef.json';

it.each([
  ['no home', {}, {}],
  ['a fresh config.toml', { 'config.toml': FRESH_CONFIG }, {}],
  ['only KIMI_API_KEY in the shell', { 'config.toml': FRESH_CONFIG }, { KIMI_API_KEY: 'k' }],
  ['an OAuth provider with no credential file', { 'config.toml': oauthConfig('') }, {}],
  [
    'an unreadable credential file',
    { 'config.toml': oauthConfig(''), [CREDENTIAL]: '{not json' },
    {},
  ],
  [
    'a credential file without a refresh token',
    { 'config.toml': oauthConfig(''), [CREDENTIAL]: '{"refresh_token":""}' },
    {},
  ],
])('reports Kimi signed out with %s', async (_name, files, env) => {
  const dir = await home(files);
  expect(await checkKimiSignIn({ KIMI_CODE_HOME: join(dir, 'home'), ...env })).toMatchObject({
    status: 'unauthenticated',
    message: 'Sign in on the execution machine with kimi login.',
  });
  if (Object.keys(files).length)
    expect(await checkKimiSignIn({ KIMI_CODE_HOME: dir, ...env })).toMatchObject({
      status: 'unauthenticated',
    });
});

it.each([
  [
    'an OAuth login',
    { 'config.toml': oauthConfig(''), [CREDENTIAL]: '{"refresh_token":"r","access_token":"a"}' },
    {},
  ],
  ['a provider API key', { 'config.toml': oauthConfig('sk-synthetic') }, {}],
  [
    'KIMI_MODEL_NAME and KIMI_MODEL_API_KEY with no home',
    {},
    { KIMI_MODEL_NAME: 'kimi-k3', KIMI_MODEL_API_KEY: 'k' },
  ],
])('reports Kimi signed in with %s', async (_name, files, env) => {
  const dir = await home(files);
  expect((await checkKimiSignIn({ KIMI_CODE_HOME: dir, ...env })).status).toBe('authenticated');
});

it('says KIMI_MODEL_API_KEY is missing, not to sign in, when only KIMI_MODEL_NAME is set', async () => {
  const dir = await home({
    'config.toml': oauthConfig(''),
    [CREDENTIAL]: '{"refresh_token":"r"}',
  });
  expect(await checkKimiSignIn({ KIMI_CODE_HOME: dir, KIMI_MODEL_NAME: 'kimi-k3' })).toMatchObject({
    status: 'unauthenticated',
    message: 'KIMI_MODEL_NAME is set but KIMI_MODEL_API_KEY is missing.',
    loginHelps: false,
  });
});

it('reports the sign-in unknown when config.toml does not parse', async () => {
  const dir = await home({ 'config.toml': '[providers\napi_key = ' });
  expect((await checkKimiSignIn({ KIMI_CODE_HOME: dir })).status).toBe('unknown');
});

it.each([
  ['approval-required', 'default'],
  ['auto-accept-edits', 'default'],
  ['auto', 'yolo'],
  ['full-access', 'yolo'],
] as const)('puts a %s session in Kimi mode %s', (runtimeMode, mode) => {
  const modes = {
    currentModeId: 'default',
    availableModes: ['default', 'plan', 'auto', 'yolo'].map((id) => ({ id, name: id })),
  };
  expect(kimiAcp.sessionMode?.(runtimeMode as RuntimeMode, modes)).toBe(mode);
  expect(kimiAcp.sessionMode?.(runtimeMode as RuntimeMode, undefined)).toBeUndefined();
});

it('reads the MCP server from the tool name', () => {
  expect(
    kimiAcp.mcpServerOf?.({
      toolCallId: '0:mcp__echo__switch_echo_0_ab',
      title: 'mcp__echo__switch_echo',
    })
  ).toBe('echo');
  expect(kimiAcp.mcpServerOf?.({ toolCallId: '1', title: 'Bash' })).toBeUndefined();
});

it('asks a question as a question, even in full access, and answers with the chosen option', async () => {
  const adapter = createKimiAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'full-access',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
  });
  const server = servers.at(-1)!;
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  server.send({
    id: 80,
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
  await flush();
  const asked = events.find((e) => e.type === 'user-input.requested');
  if (asked?.type !== 'user-input.requested') throw new Error('No question');
  expect(asked.questions).toMatchObject([
    {
      question: 'Which color?',
      options: [
        { label: 'red', value: 'q0_opt_0' },
        { label: 'green', value: 'q0_opt_1' },
      ],
    },
  ]);
  expect(events.some((e) => e.type === 'request.opened')).toBe(false);
  await adapter.respondToUserInput('s', asked.requestId, { [asked.questions[0]!.id]: 'q0_opt_1' });
  await flush();
  expect(server.received.find((m) => m.id === 80)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'q0_opt_1' },
  });
});

it.each([
  'Agent',
  'AgentSwarm',
  'Launching coder agent: fix the tests',
  'Launching background explore agent: map the repo',
  'Launching agent swarm: review each file',
])("types Kimi's subagent tool titled %j as a subagent", (title) => {
  expect(kimiAcp.itemType?.({ toolCallId: '0:Agent_0', title })).toBe('subagent');
});

it.each(['Bash', 'mcp__switch__agent_status', 'Launching the build'])(
  'leaves the tool titled %j as it is',
  (title) => {
    expect(kimiAcp.itemType?.({ toolCallId: '1', title })).toBeUndefined();
  }
);

it('passes through what Kimi reads to find its home or sign in with a key', () => {
  expect(kimiAcp.inheritEnv).toEqual([
    'KIMI_CODE_HOME',
    'KIMI_SHELL_PATH',
    'KIMI_MODEL_NAME',
    'KIMI_MODEL_API_KEY',
    'KIMI_MODEL_PROVIDER_TYPE',
    'KIMI_MODEL_BASE_URL',
  ]);
});
