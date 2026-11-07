import type * as fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAcpSignIn } from '../acp/acp-adapter';
import type { AcpConfigOption } from '../acp/protocol';
import type { ProviderSessionStartInput } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));

const servers: FakeAppServer[] = [];
const spawned: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
/** What the fake Junie declares and offers; reset before each test. */
const junie = {
  authMethods: [] as Array<{ id: string; name: string }>,
  braveMode: true,
  authStatuses: [] as Array<Record<string, unknown>>,
  authRequired: false,
  modelOffered: true,
};
const BRAVE_MODE: AcpConfigOption = {
  id: 'brave_mode',
  type: 'select',
  currentValue: 'off',
  options: [
    { value: 'brave-auto', name: 'Auto' },
    { value: 'on', name: 'Brave' },
    { value: 'off', name: 'Safe' },
  ],
};
const MODEL: AcpConfigOption = {
  id: 'model',
  type: 'select',
  currentValue: 'mix.normal',
  options: [
    {
      options: [
        { value: 'mix.normal', name: 'Default' },
        { value: 'sonnet', name: 'Claude Sonnet' },
      ],
    },
  ],
};
const configOptions = () => [
  ...(junie.braveMode ? [BRAVE_MODE] : []),
  ...(junie.modelOffered ? [MODEL] : []),
];

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: { env: Record<string, string> }) => {
    spawned.push({ command, args, env: options.env });
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
      authMethods: junie.authMethods,
    }));
    server.on('message', (message: { id?: number; method?: string }) => {
      if (message.method !== 'session/new' || message.id === undefined) return;
      if (junie.authRequired) {
        server.send({
          id: message.id,
          error: { code: -32000, message: 'Authentication required' },
        });
        return;
      }
      for (const authStatus of junie.authStatuses)
        setImmediate(() =>
          server.notify('_auth/status_update', { sessionId: 'native', authStatus })
        );
      server.send({
        id: message.id,
        result: { sessionId: 'native', configOptions: configOptions() },
      });
    });
    server.replyAlways('session/load', () => ({
      sessionId: 'native',
      configOptions: configOptions(),
    }));
    server.replyAlways('session/set_config_option', () => ({ configOptions: configOptions() }));
    servers.push(server);
    return server;
  },
}));

const {
  createJunieAdapter,
  junieAcp,
  junieBraveMode,
  junieMcpServer,
  junieReadiness,
  junieSessionReport,
  junieSubagent,
  readinessFromAuthStatus,
} = await import('./junie-adapter');

beforeEach(() => {
  servers.length = 0;
  spawned.length = 0;
  junie.authMethods = [
    { id: 'jetbrains-account', name: 'Junie Account' },
    { id: 'junie-cli', name: 'Junie CLI (interactive)' },
  ];
  junie.braveMode = true;
  junie.authStatuses = [];
  junie.authRequired = false;
  junie.modelOffered = true;
});

async function setup(input: Partial<ProviderSessionStartInput> = {}) {
  const adapter = createJunieAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: { HOME: '/home/dev' },
    mcpServers: {
      switch: {
        transport: 'http',
        url: 'http://127.0.0.1:4567/mcp',
        headers: { Authorization: 'Bearer per-session' },
      },
      github: { transport: 'stdio', command: 'node', args: ['github.js'], env: {} },
    },
    connectorMcpServers: ['github'],
    ...input,
  });
  return { adapter, events, server: servers.at(-1)!, session };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const configSet = (server: FakeAppServer, configId: string) =>
  server.received.find(
    (m) => m.method === 'session/set_config_option' && m.params?.configId === configId
  )?.params;

describe('sessions', () => {
  it('runs junie in ACP mode without update checks, on the environment it was given', async () => {
    const { server } = await setup();
    expect(spawned.at(-1)).toEqual({
      command: 'junie',
      args: ['--acp=true', '--skip-update-check'],
      env: { HOME: '/home/dev' },
    });
    expect(server.received.some((m) => m.method === 'authenticate')).toBe(false);
  });

  it.each([
    ['approval-required', 'off'],
    ['auto-accept-edits', 'off'],
    ['auto', 'brave-auto'],
    ['full-access', 'on'],
  ] as const)('sets brave mode for %s to %s', async (runtimeMode, value) => {
    const { server } = await setup({ runtimeMode });
    expect(configSet(server, 'brave_mode')).toEqual({
      sessionId: 'native',
      configId: 'brave_mode',
      value,
    });
  });

  it('picks the brave mode by its label when Junie names the value differently', () => {
    const offered: AcpConfigOption[] = [
      {
        id: 'brave_mode',
        type: 'select',
        options: [
          { value: 'safe', name: 'Safe' },
          { value: 'auto', name: 'Auto' },
          { value: 'brave', name: 'Brave' },
        ],
      },
    ];
    expect(junieBraveMode('approval-required', offered)).toBe('safe');
    expect(junieBraveMode('full-access', offered)).toBe('brave');
    expect(() => junieBraveMode('auto', [MODEL])).toThrow('no brave_mode session option');
    expect(() =>
      junieBraveMode('auto', [{ id: 'brave_mode', type: 'select', options: [] }])
    ).toThrow('no brave mode for auto');
  });

  it('refuses to start without a brave mode to set, naming the option', async () => {
    junie.braveMode = false;
    await expect(setup({ runtimeMode: 'full-access' })).rejects.toThrow(
      'Junie offers no brave_mode session option'
    );
  });

  it('registers the session MCP servers and sets the chosen model through its config option', async () => {
    const { adapter, server } = await setup({ model: { id: 'sonnet' } });
    expect(server.received.find((m) => m.method === 'session/new')?.params).toMatchObject({
      cwd: '/work',
      mcpServers: [
        {
          name: 'switch',
          type: 'http',
          url: 'http://127.0.0.1:4567/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer per-session' }],
        },
        { name: 'github', command: 'node', args: ['github.js'], env: [] },
      ],
    });
    expect(configSet(server, 'model')).toEqual({
      sessionId: 'native',
      configId: 'model',
      value: 'sonnet',
    });
    expect((await adapter.listModels('s')).map((model) => model.id)).toEqual([
      'mix.normal',
      'sonnet',
    ]);
  });

  it('resumes the saved conversation with session/load', async () => {
    const { server, session } = await setup({ resume: { nativeSessionId: 'native' } });
    expect(session.nativeSessionId).toBe('native');
    expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
      sessionId: 'native',
    });
    expect(server.received.some((m) => m.method === 'session/new')).toBe(false);
  });

  it("allows a Switch tool without asking and asks about a connector's, naming the connector", async () => {
    const { adapter, events, server } = await setup();
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'list rooms' });
    server.notify('session/update', {
      sessionId: 'native',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'mcp-switch',
        kind: 'other',
        title: 'switch/list_rooms',
        status: 'pending',
        _meta: { is_mcp_tool_call: true },
      },
    });
    const options = [
      { optionId: 'Yes', name: 'Yes', kind: 'allow_once' },
      { optionId: 'No', name: 'No', kind: 'reject_once' },
    ];
    server.send({
      id: 90,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: {
          toolCallId: 'mcp-switch',
          title: 'switch/list_rooms',
          status: 'pending',
          _meta: { is_mcp_tool_call: true },
        },
        options,
      },
    });
    await flush();
    expect(events.find((e) => e.type === 'item.started')).toMatchObject({
      item: { id: 'mcp-switch', type: 'mcp_tool_call' },
    });
    expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
    expect(server.received.find((m) => m.id === 90)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'Yes' },
    });

    server.send({
      id: 91,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: {
          toolCallId: 'mcp-github',
          title: 'github/create_issue',
          _meta: { is_mcp_tool_call: true },
        },
        options,
      },
    });
    await flush();
    const connector = events.filter((e) => e.type === 'request.opened').at(-1);
    expect(connector).toMatchObject({ requestType: 'mcp_tool_approval', connector: 'github' });

    server.send({
      id: 92,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: {
          toolCallId: 'mcp-jira',
          title: 'jira/create',
          _meta: { is_mcp_tool_call: true },
        },
        options,
      },
    });
    await flush();
    const unregistered = events.filter((e) => e.type === 'request.opened').at(-1);
    expect(unregistered).toMatchObject({ requestType: 'tool_approval' });
    expect(unregistered).not.toHaveProperty('connector');
  });

  it('never offers the always-allow and never-allow Junie would remember for every later run', async () => {
    const { adapter, events, server } = await setup();
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run tests' });
    server.send({
      id: 93,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId: 'shell', kind: 'execute', title: 'npm test' },
        options: [
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          { optionId: 'never', name: 'Never allow', kind: 'reject_always' },
        ],
      },
    });
    await flush();
    const request = events.find((e) => e.type === 'request.opened');
    if (!request || request.type !== 'request.opened') throw new Error('missing approval');
    expect(request.requestType).toBe('command_execution_approval');
    expect(request.options).toEqual([
      { decision: 'accept', label: 'Allow once' },
      { decision: 'decline', label: 'Deny' },
      { decision: 'cancel', label: 'Cancel' },
    ]);
    await adapter.respondToRequest('s', request.requestId, 'accept');
    await flush();
    expect(server.received.find((m) => m.id === 93)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' },
    });
  });

  it('reports a turn Junie cancels on its own as an error, not an interruption', async () => {
    const { adapter, events, server } = await setup();
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'hello' });
    const prompt = await server.waitFor('session/prompt');
    server.send({ id: prompt.id, result: { stopReason: 'cancelled' } });
    await flush();
    expect(events.find((e) => e.type === 'turn.completed')).toMatchObject({
      turnId: 't',
      outcome: 'error',
      message: 'Junie cancelled the turn itself, without being interrupted.',
    });
    expect(events.at(-1)).toMatchObject({ type: 'session.state.changed', status: 'error' });
  });

  it('shows a delegated run as a subagent, from its title or a marker', async () => {
    const { adapter, events, server } = await setup();
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'delegate' });
    for (const status of ['in_progress', 'completed']) {
      server.notify('session/update', {
        sessionId: 'native',
        update: {
          sessionUpdate: status === 'in_progress' ? 'tool_call' : 'tool_call_update',
          toolCallId: 'run-1',
          kind: 'think',
          title: 'Subagent readme-reader',
          status,
        },
      });
    }
    expect(events.find((e) => e.type === 'item.started')).toMatchObject({
      item: { id: 'run-1', type: 'subagent', title: 'Subagent readme-reader' },
    });
    expect(events.find((e) => e.type === 'item.completed')).toMatchObject({
      item: { id: 'run-1', type: 'subagent', status: 'completed' },
    });
    expect(
      junieSubagent({ toolCallId: 'x', title: 'Delegate', _meta: { junie: { subagent: true } } })
    ).toBe(true);
    expect(junieSubagent({ toolCallId: 'y', kind: 'think', title: 'Thinking' })).toBe(false);
  });
});

describe('MCP tool naming', () => {
  const marked = { _meta: { is_mcp_tool_call: true } };

  it('reads the server from the <server>/<tool> title of a marked call', () => {
    expect(junieMcpServer({ toolCallId: 'a', title: 'echo/switch_echo', ...marked })).toBe('echo');
    expect(
      junieMcpServer({ toolCallId: 'b', title: 'github-server/create_issue', ...marked })
    ).toBe('github-server');
    expect(junieMcpServer({ toolCallId: 'c', title: 'switch:send_message', ...marked })).toBe(
      'switch'
    );
  });

  it('names no server for a call Junie does not mark as MCP, or names without one', () => {
    expect(junieMcpServer({ toolCallId: 'a', title: 'switch/list_rooms' })).toBeUndefined();
    expect(junieMcpServer({ toolCallId: 'b', title: 'list_rooms', ...marked })).toBeUndefined();
    expect(
      junieMcpServer({ toolCallId: 'c', kind: 'execute', title: 'echo 12:30' })
    ).toBeUndefined();
  });
});

describe('sign-in check', () => {
  const input = { binaryPath: 'junie', cwd: '/work', env: {} };
  const methods = () => servers.at(-1)!.received.map((m) => m.method);

  it('takes a Junie API key in the environment as signed in without starting Junie', async () => {
    const result = await checkAcpSignIn(junieAcp, { ...input, env: { JUNIE_API_KEY: 'perm-x' } });
    expect(result.status).toBe('authenticated');
    expect(spawned).toHaveLength(0);
  });

  it('reads the account from the status Junie publishes for an empty session, never calling authenticate', async () => {
    junie.authStatuses = [
      { kind: 'none', label: 'Not ready', detail: 'Waiting for account or model' },
      { kind: 'account', label: 'JetBrains AI', account: { email: 'dev@example.com' } },
    ];
    const result = await checkAcpSignIn(junieAcp, input);
    expect(result.status).toBe('authenticated');
    expect(result.message).toContain('dev@example.com');
    expect(methods()).toEqual(['initialize', 'session/new']);
  });

  /** A connection whose `session/new` answers `result` and then publishes `notifications` in order. */
  function connectionWith(
    result: Record<string, unknown>,
    notifications: Array<{ method: string; params: Record<string, unknown> }>
  ) {
    const handlers = new Map<string, Array<(params: unknown) => void>>();
    return {
      onNotification: (method: string, handler: (params: unknown) => void) => {
        handlers.set(method, [...(handlers.get(method) ?? []), handler]);
      },
      request: (async () => {
        for (const { method, params } of notifications)
          setImmediate(() => handlers.get(method)?.forEach((handler) => handler(params)));
        return result;
      }) as never,
    };
  }
  const modelUpdate = {
    method: 'session/update',
    params: {
      sessionId: 'probe',
      update: { sessionUpdate: 'config_option_update', configOptions: [BRAVE_MODE, MODEL] },
    },
  };
  const account = {
    method: '_auth/status_update',
    params: { sessionId: 'probe', authStatus: { kind: 'account', label: 'JetBrains AI' } },
  };

  it('reports an account that never settles as signed out, saying how to sign in', async () => {
    const report = await junieSessionReport(
      connectionWith({ sessionId: 'probe' }, [
        {
          method: '_auth/status_update',
          params: { sessionId: 'probe', authStatus: { kind: 'none', label: 'Not ready' } },
        },
      ]),
      '/work',
      50,
      10
    );
    expect(report).toEqual({ status: { kind: 'none', label: 'Not ready' }, modelsOffered: false });
    const result = junieReadiness(report);
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain('run junie');
  });

  it('reports a signed-in account that offers no model as unusable, with sign-in no help', async () => {
    const report = await junieSessionReport(
      connectionWith({ sessionId: 'probe', configOptions: [BRAVE_MODE] }, [account]),
      '/work',
      5_000,
      50
    );
    expect(report).toEqual({ status: account.params.authStatus, modelsOffered: false });
    const result = junieReadiness(report);
    expect(result).toMatchObject({ status: 'unconfigured', loginHelps: false });
    expect(result.message).toContain('no Junie licence');
  });

  it('counts a model offered at session start or in a later config update', async () => {
    const atStart = await junieSessionReport(
      connectionWith({ sessionId: 'probe', configOptions: [BRAVE_MODE, MODEL] }, [account]),
      '/work',
      5_000,
      5_000
    );
    expect(atStart.modelsOffered).toBe(true);
    const later = await junieSessionReport(
      connectionWith({ sessionId: 'probe', configOptions: [BRAVE_MODE] }, [account, modelUpdate]),
      '/work',
      5_000,
      5_000
    );
    expect(later.modelsOffered).toBe(true);
    expect(junieReadiness(later).status).toBe('authenticated');
  });

  it('treats a session refused for want of authentication as signed out', async () => {
    junie.authRequired = true;
    expect((await checkAcpSignIn(junieAcp, input)).status).toBe('unauthenticated');
  });

  it('counts a handshake that lists no sign-in methods as signed in', async () => {
    junie.authMethods = [];
    expect((await checkAcpSignIn(junieAcp, input)).status).toBe('authenticated');
    expect(methods()).toEqual(['initialize']);
  });

  it('does not claim to know when Junie publishes no status in time', async () => {
    const report = await junieSessionReport(
      connectionWith({ sessionId: 'quiet' }, []),
      '/work',
      1,
      1
    );
    expect(report).toEqual({ status: null, modelsOffered: false });
    expect(junieReadiness(report).status).toBe('unknown');
    expect((await checkAcpSignIn(junieAcp, input)).status).toBe('unknown');
  }, 20_000);

  it('never sends authenticate while waiting for the account to settle', async () => {
    junie.authStatuses = [{ kind: 'api_key', label: 'Anthropic' }];
    expect((await checkAcpSignIn(junieAcp, input)).message).toBe(
      'Signed in to Junie with an API key (Anthropic).'
    );
    expect(methods()).toEqual(['initialize', 'session/new']);
  });

  it('names each kind of sign-in Junie reports', () => {
    expect(readinessFromAuthStatus({ kind: 'api_key' }).status).toBe('authenticated');
    expect(readinessFromAuthStatus({ kind: 'gateway' }).status).toBe('authenticated');
    expect(readinessFromAuthStatus({ kind: 'copilot-ish' })).toMatchObject({
      status: 'unknown',
      message: expect.stringContaining("'copilot-ish'"),
    });
  });
});
