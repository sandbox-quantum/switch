import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConversationUnavailableError, type RuntimeMode } from '../adapter';
import type { ProviderRuntimeEvent, ProviderRuntimeEventType } from '../events';
import { FakeAppServer, type FakeJsonRpcMessage } from './fake-app-server';

const servers: FakeAppServer[] = [];
let account: Record<string, unknown> | null = { type: 'apiKey' };
let requiresOpenaiAuth = true;

vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[]) => {
    const server = new FakeAppServer();
    Object.assign(server, { spawnArgs: args });
    server.replyAlways('initialize', () => ({ userAgent: 'fake' }));
    server.replyAlways('account/read', () => ({
      account,
      requiresOpenaiAuth,
    }));
    server.replyAlways('thread/start', () => ({ thread: { id: 'thread-1' } }));
    servers.push(server);
    return server;
  },
}));

const { CODEX_SIGN_IN_REQUIRED, createCodexAdapter } = await import('./codex-adapter');

const THREAD = 'thread-1';

function eventsOf<T extends ProviderRuntimeEventType>(
  events: ProviderRuntimeEvent[],
  type: T
): Array<Extract<ProviderRuntimeEvent, { type: T }>> {
  return events.filter(
    (event): event is Extract<ProviderRuntimeEvent, { type: T }> => event.type === type
  );
}

async function start(runtimeMode: RuntimeMode = 'full-access') {
  const adapter = createCodexAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const session = await adapter.startSession({
    sessionId: 'session-1',
    cwd: '/work',
    runtimeMode,
    env: { PATH: '/usr/bin' },
    mcpServers: {},
    connectorMcpServers: [],
  });
  const server = servers.at(-1);
  if (!server) throw new Error('fake app-server was not spawned');
  return { adapter, events, server, session };
}

function turnNotification(id: string, status: string) {
  return { threadId: THREAD, turn: { id, status, error: null } };
}

describe('CodexAdapter', () => {
  beforeEach(() => {
    servers.length = 0;
    account = { type: 'apiKey' };
    requiresOpenaiAuth = true;
  });

  it('checks authentication on the session process before opening a thread', async () => {
    const { adapter, server } = await start();
    expect(servers).toHaveLength(1);
    expect(server.received.findIndex((m) => m.method === 'account/read')).toBeLessThan(
      server.received.findIndex((m) => m.method === 'thread/start')
    );
    await adapter.stopAll();
  });

  it('rejects signed-out startup without opening a thread', async () => {
    account = null;
    await expect(start()).rejects.toThrow('codex login');
    expect(servers[0].received.some((m) => m.method === 'thread/start')).toBe(false);
  });

  it('explains that an isolated session cannot use a keyring login, and the file workaround', async () => {
    account = null;
    const exited = vi.fn();
    const failed = start();
    servers.at(-1)?.on('exit', exited);
    const error = await failed.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(CODEX_SIGN_IN_REQUIRED);
    expect(message).toContain('OS keyring');
    expect(message).toContain('cli_auth_credentials_store = "file"');
    expect(message).toContain('start a new session');
    expect(message).toContain('plaintext');
    expect(servers).toHaveLength(1);
    expect(servers[0].received.map((m) => m.method)).toEqual([
      'initialize',
      'initialized',
      'account/read',
    ]);
    expect(exited).toHaveBeenCalled();
  });

  it('keeps the diagnostic static, with nothing from the session environment in it', async () => {
    account = null;
    const marker = 'placeholder-secret-marker';
    const adapter = createCodexAdapter();
    const failure = adapter.startSession({
      sessionId: 'session-1',
      cwd: `/work/${marker}`,
      runtimeMode: 'full-access',
      env: { PATH: '/usr/bin', CODEX_HOME: `/home/${marker}`, OPENAI_API_KEY: marker },
      mcpServers: {},
      connectorMcpServers: [],
    });
    await expect(failure).rejects.toThrow(CODEX_SIGN_IN_REQUIRED);
    await expect(failure).rejects.not.toThrow(marker);
    await expect(adapter.interruptTurn('session-1')).rejects.toThrow(/unknown or stopped session/);
  });

  it('starts with a recognized login even when the backend requires OpenAI sign-in', async () => {
    for (const recognized of [
      { type: 'apiKey' },
      { type: 'chatgpt', email: null, planType: null },
    ]) {
      account = recognized;
      const { adapter, session } = await start();
      expect(session.nativeSessionId).toBe(THREAD);
      await adapter.stopAll();
    }
  });

  it('starts without a login when the backend does not require OpenAI sign-in', async () => {
    account = null;
    requiresOpenaiAuth = false;
    const { adapter, session } = await start();
    expect(session.nativeSessionId).toBe(THREAD);
    await adapter.stopAll();
  });

  it('initializes, opens a thread and reports the thread id as the native session', async () => {
    const { server, session, events } = await start();
    expect(session.nativeSessionId).toBe(THREAD);
    expect(eventsOf(events, 'session.started')[0]?.nativeSessionId).toBe(THREAD);
    const threadStart = server.received.find((message) => message.method === 'thread/start');
    expect(threadStart?.params).not.toHaveProperty('sandbox');
    expect(threadStart?.params).toMatchObject({
      cwd: '/work',
      approvalPolicy: 'never',
    });
  });

  it('passes the sandbox its configuration names, on a resumed thread as on a new one', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-home-'));
    try {
      await writeFile(join(home, 'config.toml'), 'sandbox_mode = "workspace-write"\n');
      const adapter = createCodexAdapter();
      const pending = adapter.startSession({
        sessionId: 'resumed',
        cwd: '/work',
        runtimeMode: 'full-access',
        env: { PATH: '/usr/bin', CODEX_HOME: home },
        mcpServers: {},
        connectorMcpServers: [],
        resume: { nativeSessionId: THREAD },
      });
      const server = servers.at(-1)!;
      server.replyAlways('thread/resume', () => ({ thread: { id: THREAD } }));
      await pending;
      const resumed = server.received.find((message) => message.method === 'thread/resume');
      expect(resumed?.params).toMatchObject({
        threadId: THREAD,
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
      });
      await adapter.stopAll();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('fails resume without silently opening a fresh thread', async () => {
    const adapter = createCodexAdapter();
    const pending = adapter.startSession({
      sessionId: 'resume',
      cwd: '/work',
      runtimeMode: 'approval-required',
      env: { PATH: '/usr/bin' },
      mcpServers: {},
      connectorMcpServers: [],
      resume: { nativeSessionId: 'missing' },
    });
    const server = servers.at(-1)!;
    server.on('message', (message: FakeJsonRpcMessage) => {
      if (message.method === 'thread/resume')
        server.send({ id: message.id, error: { code: -32000, message: 'no rollout found' } });
    });
    await expect(pending).rejects.toThrow('no rollout found');
    expect(server.received.filter((message) => message.method === 'thread/start')).toHaveLength(0);
    expect(adapter.hasSession('resume')).toBe(false);
  });

  it('classifies a missing saved rollout without starting another thread', async () => {
    const adapter = createCodexAdapter();
    const pending = adapter.startSession({
      sessionId: 'resume',
      cwd: '/work',
      runtimeMode: 'approval-required',
      env: { PATH: '/usr/bin' },
      mcpServers: {},
      connectorMcpServers: [],
      resume: { nativeSessionId: 'missing' },
    });
    const server = servers.at(-1)!;
    server.on('message', (message: FakeJsonRpcMessage) => {
      if (message.method === 'thread/resume')
        server.send({
          id: message.id,
          error: {
            code: -32600,
            message: 'no rollout found for thread id missing',
          },
        });
    });
    await expect(pending).rejects.toBeInstanceOf(ProviderConversationUnavailableError);
    expect(server.received.filter((message) => message.method === 'thread/start')).toHaveLength(0);
    expect(adapter.hasSession('resume')).toBe(false);
  });

  it('marks the working directory untrusted in approval-required mode, not a retired policy', async () => {
    const { server } = await start('approval-required');
    const threadStart = server.received.find((message) => message.method === 'thread/start');
    expect(threadStart?.params).not.toHaveProperty('sandbox');
    expect(threadStart?.params).not.toHaveProperty('approvalPolicy');
    const args = (server as unknown as { spawnArgs: string[] }).spawnArgs;
    const override = args.indexOf('-c');
    expect(args.slice(override, override + 2)).toEqual([
      '-c',
      'projects={"/work"={trust_level="untrusted"}}',
    ]);
  });

  it('sends on-request for auto-accept-edits and never for full access, with no project override', async () => {
    for (const [mode, approvalPolicy] of [
      ['auto-accept-edits', 'on-request'],
      ['full-access', 'never'],
    ] as const) {
      const { server } = await start(mode);
      const threadStart = server.received.find((message) => message.method === 'thread/start');
      expect(threadStart?.params).toMatchObject({ approvalPolicy });
      const args = (server as unknown as { spawnArgs: string[] }).spawnArgs;
      expect(args.some((arg) => arg.startsWith('projects='))).toBe(false);
    }
  });

  it('leaves approvals to the person in every mode but auto', async () => {
    for (const mode of ['approval-required', 'auto-accept-edits', 'full-access'] as const) {
      const { server } = await start(mode);
      const threadStart = server.received.find((message) => message.method === 'thread/start');
      expect(threadStart?.params).toMatchObject({ approvalsReviewer: 'user' });
    }
  });

  it("sends on-request with Codex's automatic reviewer in auto mode", async () => {
    const { server } = await start('auto');
    const threadStart = server.received.find((message) => message.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    });
    expect(threadStart?.params).not.toHaveProperty('sandbox');
    const args = (server as unknown as { spawnArgs: string[] }).spawnArgs;
    expect(args.some((arg) => arg.startsWith('projects='))).toBe(false);
  });

  it('keeps the configured sandbox in auto mode, but never runs it unsandboxed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-home-'));
    try {
      for (const [configured, sent, warned] of [
        ['read-only', 'read-only', false],
        ['workspace-write', 'workspace-write', false],
        ['danger-full-access', 'workspace-write', true],
      ] as const) {
        await writeFile(join(home, 'config.toml'), `sandbox_mode = "${configured}"\n`);
        const adapter = createCodexAdapter();
        const events: ProviderRuntimeEvent[] = [];
        adapter.subscribe((event) => events.push(event));
        await adapter.startSession({
          sessionId: `auto-${configured}`,
          cwd: '/work',
          runtimeMode: 'auto',
          env: { PATH: '/usr/bin', CODEX_HOME: home },
          mcpServers: {},
          connectorMcpServers: [],
        });
        const threadStart = servers
          .at(-1)!
          .received.find((message) => message.method === 'thread/start');
        expect(threadStart?.params).toMatchObject({ sandbox: sent });
        expect(eventsOf(events, 'runtime.warning').length > 0).toBe(warned);
        await adapter.stopAll();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('carries systemContext as developer instructions', async () => {
    const adapter = createCodexAdapter();
    await adapter.startSession({
      sessionId: 's',
      cwd: '/work',
      runtimeMode: 'full-access',
      env: {},
      mcpServers: {},
      connectorMcpServers: [],
      systemContext: 'you are in a Switch room',
    });
    const server = servers.at(-1);
    expect(
      server?.received.find((message) => message.method === 'thread/start')?.params
    ).toMatchObject({ developerInstructions: 'you are in a Switch room' });
  });

  it('sends the reasoning effort selected at session start on the first turn', async () => {
    const adapter = createCodexAdapter();
    await adapter.startSession({
      sessionId: 'session-1',
      cwd: '/work',
      runtimeMode: 'full-access',
      env: { PATH: '/usr/bin' },
      mcpServers: {},
      connectorMcpServers: [],
      model: { id: 'start-model', options: { effort: 'low' } },
    });
    const server = servers.at(-1)!;
    server.replyAlways('turn/start', () => ({
      turn: { id: 'native-effort', status: 'inProgress' },
    }));
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'effort-turn', text: 'hello' });
    const turnStarts = server.received.filter((message) => message.method === 'turn/start');
    expect(turnStarts).toHaveLength(1);
    expect(turnStarts[0]?.params).toMatchObject({ model: 'start-model', effort: 'low' });
    await adapter.stopAll();
  });

  it('sends reasoning effort with model changes', async () => {
    const { adapter, server } = await start();
    server.replyAlways('turn/start', () => ({
      turn: { id: 'native-effort', status: 'inProgress' },
    }));
    await adapter.setModel('session-1', { id: 'test-model', options: { effort: 'high' } });
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'effort-turn', text: 'hello' });
    expect(
      server.received.find((message) => message.method === 'turn/start')?.params
    ).toMatchObject({ model: 'test-model', effort: 'high' });
    await adapter.stopAll();
  });

  it('attributes turn events to the caller turn id and streams assistant deltas', async () => {
    const { adapter, server, events } = await start();
    server.replyAlways('turn/start', () => ({ turn: { id: 'native-a', status: 'inProgress' } }));
    const result = await adapter.sendTurn({
      sessionId: 'session-1',
      turnId: 'caller-1',
      text: 'hi',
    });
    expect(result).toEqual({ turnId: 'caller-1' });

    server.notify('turn/started', turnNotification('native-a', 'inProgress'));
    server.notify('item/agentMessage/delta', {
      threadId: THREAD,
      turnId: 'native-a',
      itemId: 'msg-1',
      delta: 'hello',
    });
    server.notify('turn/completed', turnNotification('native-a', 'completed'));

    await vi.waitFor(() => expect(eventsOf(events, 'turn.completed')).toHaveLength(1));
    expect(eventsOf(events, 'turn.started')[0]?.turnId).toBe('caller-1');
    expect(eventsOf(events, 'content.delta')[0]).toMatchObject({
      turnId: 'caller-1',
      delta: 'hello',
    });
    expect(eventsOf(events, 'turn.completed')[0]).toMatchObject({
      turnId: 'caller-1',
      outcome: 'completed',
    });
  });

  it("reports each turn's share of the thread's running token total", async () => {
    const { adapter, server, events } = await start();
    const breakdown = (input: number, cached: number, output: number) => ({
      totalTokens: input + output,
      inputTokens: input,
      cachedInputTokens: cached,
      cacheWriteInputTokens: 0,
      outputTokens: output,
      reasoningOutputTokens: 0,
    });
    const usageUpdate = (turnId: string, input: number, cached: number, output: number) => ({
      threadId: THREAD,
      turnId,
      tokenUsage: {
        total: breakdown(input, cached, output),
        last: breakdown(input, cached, output),
        modelContextWindow: null,
      },
    });
    let native = 0;
    server.replyAlways('turn/start', () => ({
      turn: { id: `native-${++native}`, status: 'inProgress' },
    }));

    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-1', text: 'one' });
    server.notify('turn/started', turnNotification('native-1', 'inProgress'));
    server.notify('thread/tokenUsage/updated', usageUpdate('native-1', 100, 60, 10));
    server.notify('turn/completed', turnNotification('native-1', 'completed'));
    await vi.waitFor(() => expect(eventsOf(events, 'turn.completed')).toHaveLength(1));

    await adapter.setModel('session-1', { id: 'gpt-x', options: {} });
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-2', text: 'two' });
    server.notify('turn/started', turnNotification('native-2', 'inProgress'));
    server.notify('thread/tokenUsage/updated', usageUpdate('native-2', 150, 90, 14));
    server.notify('turn/completed', turnNotification('native-2', 'completed'));
    await vi.waitFor(() => expect(eventsOf(events, 'turn.completed')).toHaveLength(2));

    expect(eventsOf(events, 'turn.completed').map((event) => event.usage)).toEqual([
      [{ model: '', inputTokens: 40, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 0 }],
      [
        {
          model: 'gpt-x',
          inputTokens: 20,
          outputTokens: 4,
          cacheReadTokens: 30,
          cacheWriteTokens: 0,
        },
      ],
    ]);
    await expect(adapter.contextUsage('session-1')).resolves.toEqual({
      usedTokens: 164,
      windowTokens: null,
    });
  });

  it("counts a resumed thread from its first report, not from the thread's history", async () => {
    const { adapter, server, events } = await start();
    const breakdown = (input: number, output: number) => ({
      totalTokens: input + output,
      inputTokens: input,
      cachedInputTokens: 0,
      outputTokens: output,
      reasoningOutputTokens: 0,
    });
    server.replyAlways('turn/start', () => ({ turn: { id: 'native-1', status: 'inProgress' } }));

    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-1', text: 'one' });
    server.notify('turn/started', turnNotification('native-1', 'inProgress'));
    server.notify('thread/tokenUsage/updated', {
      threadId: THREAD,
      turnId: 'native-1',
      tokenUsage: {
        total: breakdown(5000, 900),
        last: breakdown(120, 30),
        modelContextWindow: null,
      },
    });
    server.notify('thread/tokenUsage/updated', {
      threadId: THREAD,
      turnId: 'native-1',
      tokenUsage: {
        total: breakdown(5200, 950),
        last: breakdown(200, 50),
        modelContextWindow: null,
      },
    });
    server.notify('turn/completed', turnNotification('native-1', 'completed'));
    await vi.waitFor(() => expect(eventsOf(events, 'turn.completed')).toHaveLength(1));

    expect(eventsOf(events, 'turn.completed')[0]?.usage).toEqual([
      { model: '', inputTokens: 320, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  it('binds a turn even when turn/started arrives before the turn/start response', async () => {
    const { adapter, server, events } = await start();
    server.on('message', (message: FakeJsonRpcMessage) => {
      if (message.method !== 'turn/start' || message.id === undefined) return;
      server.notify('turn/started', turnNotification('native-a', 'inProgress'));
      server.send({ id: message.id, result: { turn: { id: 'native-a', status: 'inProgress' } } });
    });
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-1', text: 'hi' });
    server.notify('turn/completed', turnNotification('native-a', 'completed'));
    await vi.waitFor(() => expect(eventsOf(events, 'turn.completed')).toHaveLength(1));
    expect(eventsOf(events, 'turn.started').map((event) => event.turnId)).toEqual(['caller-1']);
  });

  it('steers a message into the running turn and reports the turn it joined', async () => {
    const { adapter, server, events } = await start();
    server.replyAlways('turn/start', () => ({ turn: { id: 'native-a', status: 'inProgress' } }));
    server.replyAlways('turn/steer', () => ({ turnId: 'native-a' }));
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-1', text: 'count' });
    server.notify('turn/started', turnNotification('native-a', 'inProgress'));

    const steered = await adapter.sendTurn({
      sessionId: 'session-1',
      turnId: 'caller-2',
      text: 'stop',
    });
    expect(steered).toEqual({ turnId: 'caller-2', steeredInto: 'caller-1' });
    const steer = server.received.find((message) => message.method === 'turn/steer');
    expect(steer?.params).toMatchObject({ threadId: THREAD, expectedTurnId: 'native-a' });

    server.notify('turn/completed', turnNotification('native-a', 'completed'));
    await vi.waitFor(() => expect(eventsOf(events, 'turn.completed')).toHaveLength(1));
  });

  it('settles unfinished items when interruption omits item/completed', async () => {
    const { adapter, server, events } = await start();
    server.replyAlways('turn/start', () => ({ turn: { id: 'native-a', status: 'inProgress' } }));
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-1', text: 'run' });
    const item = {
      type: 'commandExecution',
      id: 'command',
      command: 'sleep 90',
      cwd: '/work',
      status: 'inProgress',
      aggregatedOutput: null,
      exitCode: null,
    };
    server.notify('item/started', { threadId: THREAD, turnId: 'native-a', item });
    server.notify('item/commandExecution/outputDelta', {
      threadId: THREAD,
      turnId: 'native-a',
      itemId: 'command',
      delta: 'started',
    });
    server.notify('turn/completed', turnNotification('native-a', 'interrupted'));
    await vi.waitFor(() => expect(eventsOf(events, 'turn.completed')).toHaveLength(1));
    expect(eventsOf(events, 'item.completed')).toHaveLength(1);
    expect(eventsOf(events, 'item.completed')[0]?.item).toMatchObject({
      id: 'command',
      status: 'failed',
      text: 'started\nInterrupted.',
    });
    expect(eventsOf(events, 'turn.completed')[0]).toMatchObject({
      outcome: 'interrupted',
      message: 'Interrupted.',
    });
    await adapter.stopAll();
  });

  it('terminates only the interrupted turn commands, including paginated terminals', async () => {
    const { adapter, server } = await start();
    server.replyAlways('turn/start', () => ({ turn: { id: 'native-a', status: 'inProgress' } }));
    server.replyAlways('turn/interrupt', () => ({}));
    let page = 0;
    server.replyAlways('thread/backgroundTerminals/list', () =>
      ++page === 1
        ? { data: [{ itemId: 'older-command', processId: 'keep' }], nextCursor: 'next' }
        : { data: [{ itemId: 'command', processId: 'stop' }], nextCursor: null }
    );
    server.replyAlways('thread/backgroundTerminals/terminate', () => ({ terminated: true }));
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-1', text: 'run' });
    server.notify('turn/started', turnNotification('native-a', 'inProgress'));
    server.notify('item/started', {
      threadId: THREAD,
      turnId: 'native-a',
      item: {
        type: 'commandExecution',
        id: 'command',
        command: 'sleep 90',
        cwd: '/work',
        status: 'inProgress',
        aggregatedOutput: null,
        exitCode: null,
      },
    });
    await adapter.interruptTurn('session-1');
    expect(
      server.received
        .filter((message) => message.method === 'thread/backgroundTerminals/terminate')
        .map((message) => message.params)
    ).toEqual([{ threadId: THREAD, processId: 'stop' }]);
    await adapter.stopAll();
  });

  it('interrupts the active turn, not a turn that was queued behind it', async () => {
    const { adapter, server, events } = await start();
    let started = 0;
    server.replyAlways('turn/start', () => ({
      turn: { id: `native-${++started}`, status: 'inProgress' },
    }));
    server.on('message', (message: FakeJsonRpcMessage) => {
      if (message.method !== 'turn/steer' || message.id === undefined) return;
      server.send({ id: message.id, error: { code: -32600, message: 'turn is not steerable' } });
    });
    server.replyAlways('turn/interrupt', () => ({}));

    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-1', text: 'count' });
    server.notify('turn/started', turnNotification('native-1', 'inProgress'));
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-2', text: 'queued' });

    await adapter.interruptTurn('session-1');
    const interrupt = server.received.find((message) => message.method === 'turn/interrupt');
    expect(interrupt?.params).toEqual({ threadId: THREAD, turnId: 'native-1' });
    expect(eventsOf(events, 'runtime.warning')).toHaveLength(1);
  });

  it('opens an approval, answers it on the same request id and resolves it', async () => {
    const { adapter, server, events } = await start('approval-required');
    server.replyAlways('turn/start', () => ({ turn: { id: 'native-a', status: 'inProgress' } }));
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-1', text: 'run it' });
    server.notify('turn/started', turnNotification('native-a', 'inProgress'));

    server.send({
      id: 91,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: THREAD,
        turnId: 'native-a',
        itemId: 'exec-1',
        command: 'echo hi',
        cwd: '/work',
        reason: null,
        availableDecisions: ['accept', 'cancel'],
      },
    });
    await vi.waitFor(() => expect(eventsOf(events, 'request.opened')).toHaveLength(1));
    const opened = eventsOf(events, 'request.opened')[0]!;
    expect(opened).toMatchObject({ requestType: 'command_execution_approval', turnId: 'caller-1' });
    expect(opened.options.map((option) => option.decision)).toEqual([
      'accept',
      'cancel',
      'decline',
    ]);

    await adapter.respondToRequest('session-1', opened.requestId, 'decline');
    await vi.waitFor(() =>
      expect(server.received.some((message) => message.id === 91 && message.result)).toBe(true)
    );
    expect(server.received.find((message) => message.id === 91)?.result).toEqual({
      decision: 'decline',
    });
    expect(eventsOf(events, 'request.resolved')[0]).toMatchObject({ decision: 'decline' });
  });

  it('puts the command in detail and the reason for asking in the title', async () => {
    const { adapter, server, events } = await start('approval-required');
    server.replyAlways('turn/start', () => ({ turn: { id: 'native-a', status: 'inProgress' } }));
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-1', text: 'run it' });
    server.notify('turn/started', turnNotification('native-a', 'inProgress'));

    server.send({
      id: 92,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: THREAD,
        turnId: 'native-a',
        itemId: 'exec-1',
        command: 'rm -rf build',
        cwd: '/work',
        reason: 'Clearing stale build output',
        availableDecisions: ['accept'],
      },
    });
    await vi.waitFor(() => expect(eventsOf(events, 'request.opened')).toHaveLength(1));
    expect(eventsOf(events, 'request.opened')[0]).toMatchObject({
      title: 'Clearing stale build output',
      detail: 'rm -rf build',
    });
  });

  it('keeps the working directory visible when codex gives no reason', async () => {
    const { adapter, server, events } = await start('approval-required');
    server.replyAlways('turn/start', () => ({ turn: { id: 'native-a', status: 'inProgress' } }));
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-1', text: 'run it' });
    server.notify('turn/started', turnNotification('native-a', 'inProgress'));

    server.send({
      id: 93,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: THREAD,
        turnId: 'native-a',
        itemId: 'exec-1',
        command: 'echo hi',
        cwd: '/work',
        reason: null,
        availableDecisions: ['accept'],
      },
    });
    await vi.waitFor(() => expect(eventsOf(events, 'request.opened')).toHaveLength(1));
    expect(eventsOf(events, 'request.opened')[0]).toMatchObject({
      title: 'Run a command in /work',
      detail: 'echo hi',
    });
  });

  it('surfaces a question and answers it with the codex answer shape', async () => {
    const { adapter, server, events } = await start();
    server.replyAlways('turn/start', () => ({ turn: { id: 'native-a', status: 'inProgress' } }));
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-1', text: 'ask me' });
    server.notify('turn/started', turnNotification('native-a', 'inProgress'));

    server.send({
      id: 55,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: THREAD,
        turnId: 'native-a',
        itemId: 'ask-1',
        questions: [
          {
            id: 'q1',
            header: 'Color',
            question: 'Which color?',
            isOther: true,
            isSecret: false,
            options: [
              { label: 'red', description: '' },
              { label: 'green', description: '' },
            ],
          },
        ],
      },
    });
    await vi.waitFor(() => expect(eventsOf(events, 'user-input.requested')).toHaveLength(1));
    const asked = eventsOf(events, 'user-input.requested')[0]!;
    expect(asked.questions[0]).toMatchObject({
      id: 'q1',
      question: 'Which color?',
      allowCustomAnswer: true,
    });

    await adapter.respondToUserInput('session-1', asked.requestId, { q1: 'green' });
    await vi.waitFor(() =>
      expect(server.received.some((message) => message.id === 55 && message.result)).toBe(true)
    );
    expect(server.received.find((message) => message.id === 55)?.result).toEqual({
      answers: { q1: { answers: ['green'] } },
    });
    expect(eventsOf(events, 'user-input.resolved')).toHaveLength(1);
  });

  it('cancels anything still open when the session stops', async () => {
    const { adapter, server, events } = await start('approval-required');
    server.replyAlways('turn/start', () => ({ turn: { id: 'native-a', status: 'inProgress' } }));
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-1', text: 'run it' });
    server.notify('turn/started', turnNotification('native-a', 'inProgress'));
    server.send({
      id: 12,
      method: 'item/fileChange/requestApproval',
      params: { threadId: THREAD, turnId: 'native-a', itemId: 'p1', reason: null, grantRoot: null },
    });
    await vi.waitFor(() => expect(eventsOf(events, 'request.opened')).toHaveLength(1));

    await adapter.stopSession('session-1');
    expect(eventsOf(events, 'request.resolved')[0]).toMatchObject({ decision: 'cancel' });
    expect(eventsOf(events, 'session.exited')).toHaveLength(1);
    expect(adapter.hasSession('session-1')).toBe(false);
    expect(server.received.find((message) => message.id === 12)?.result).toEqual({
      decision: 'cancel',
    });
  });

  it('ignores notifications belonging to a subagent thread', async () => {
    const { adapter, server, events } = await start();
    server.replyAlways('turn/start', () => ({ turn: { id: 'native-a', status: 'inProgress' } }));
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-1', text: 'delegate' });
    server.notify('turn/started', {
      threadId: 'child-thread',
      turn: { id: 'child-turn', status: 'inProgress', error: null },
    });
    server.notify('turn/completed', {
      threadId: 'child-thread',
      turn: { id: 'child-turn', status: 'completed', error: null },
    });
    server.notify('turn/started', turnNotification('native-a', 'inProgress'));
    server.notify('turn/completed', turnNotification('native-a', 'completed'));

    await vi.waitFor(() => expect(eventsOf(events, 'turn.completed')).toHaveLength(1));
    expect(eventsOf(events, 'turn.started').map((event) => event.turnId)).toEqual(['caller-1']);
  });

  it('rejects calls for a session it does not have', async () => {
    const adapter = createCodexAdapter();
    await expect(adapter.interruptTurn('nope')).rejects.toThrow(/unknown or stopped session/);
  });
});

describe('CodexAdapter connector tools', () => {
  const META = {
    codex_approval_kind: 'mcp_tool_call',
    persist: ['session', 'always'],
    tool_description: 'Search issues.',
    tool_params: { jql: 'project = DEMO' },
    tool_params_display: [{ name: 'jql', value: 'project = DEMO', display_name: 'JQL' }],
  };

  async function startWithConnector(
    runtimeMode: 'full-access' | 'approval-required' | 'auto-accept-edits'
  ) {
    const adapter = createCodexAdapter();
    const events: ProviderRuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.startSession({
      sessionId: 'session-1',
      cwd: '/work',
      runtimeMode,
      env: { PATH: '/usr/bin' },
      mcpServers: {
        switch: { transport: 'http', url: 'http://127.0.0.1:4000/mcp' },
        atlassian: { transport: 'http', url: 'http://127.0.0.1:4100/mcp' },
      },
      connectorMcpServers: ['atlassian'],
    });
    const server = servers.at(-1)!;
    server.replyAlways('turn/start', () => ({ turn: { id: 'native-a', status: 'inProgress' } }));
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'caller-1', text: 'search' });
    server.notify('turn/started', turnNotification('native-a', 'inProgress'));
    return { adapter, events, server };
  }

  function elicit(server: FakeAppServer, id: number, meta: Record<string, unknown> | null) {
    server.send({
      id,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: THREAD,
        turnId: 'native-a',
        serverName: 'atlassian',
        mode: 'form',
        ...(meta ? { _meta: meta } : {}),
        message: 'Allow the atlassian MCP server to run tool "search"?',
        requestedSchema: { type: 'object', properties: {} },
      },
    });
  }

  async function answer(
    adapter: Awaited<ReturnType<typeof startWithConnector>>['adapter'],
    events: ProviderRuntimeEvent[],
    server: FakeAppServer,
    id: number,
    decision: 'accept' | 'acceptForSession' | 'decline'
  ) {
    await vi.waitFor(() => expect(eventsOf(events, 'request.opened')).toHaveLength(1));
    const opened = eventsOf(events, 'request.opened')[0]!;
    await adapter.respondToRequest('session-1', opened.requestId, decision);
    await vi.waitFor(() =>
      expect(server.received.some((message) => message.id === id && message.result)).toBe(true)
    );
    return server.received.find((message) => message.id === id)?.result;
  }

  it('opens a card naming the server and tool, with the arguments as the detail', async () => {
    const { events, server } = await startWithConnector('approval-required');
    elicit(server, 71, META);
    await vi.waitFor(() => expect(eventsOf(events, 'request.opened')).toHaveLength(1));
    const opened = eventsOf(events, 'request.opened')[0]!;
    expect(opened).toMatchObject({
      requestType: 'mcp_tool_approval',
      turnId: 'caller-1',
      title: 'atlassian wants to run search',
      detail: 'JQL: project = DEMO',
      connector: 'atlassian',
    });
    expect(opened.options.map((option) => option.decision)).toEqual([
      'accept',
      'acceptForSession',
      'decline',
      'cancel',
    ]);
  });

  it('answers accept for this one call', async () => {
    const { adapter, events, server } = await startWithConnector('approval-required');
    elicit(server, 72, META);
    expect(await answer(adapter, events, server, 72, 'accept')).toEqual({
      action: 'accept',
      content: {},
      _meta: null,
    });
  });

  it('keeps an accept for the session in _meta, where Codex reads it', async () => {
    const { adapter, events, server } = await startWithConnector('auto-accept-edits');
    elicit(server, 73, META);
    expect(await answer(adapter, events, server, 73, 'acceptForSession')).toEqual({
      action: 'accept',
      content: {},
      _meta: { persist: 'session' },
    });
  });

  it('answers decline so Codex fails the call without running it', async () => {
    const { adapter, events, server } = await startWithConnector('approval-required');
    elicit(server, 74, META);
    expect(await answer(adapter, events, server, 74, 'decline')).toMatchObject({
      action: 'decline',
      content: null,
    });
  });

  it("opens a server's own elicitation as the generic card", async () => {
    const { events, server } = await startWithConnector('approval-required');
    elicit(server, 75, null);
    await vi.waitFor(() => expect(eventsOf(events, 'request.opened')).toHaveLength(1));
    const opened = eventsOf(events, 'request.opened')[0]!;
    expect(opened.title).toBe('atlassian needs a decision');
    expect(opened.detail).toBe('Allow the atlassian MCP server to run tool "search"?');
    expect(opened.options.map((option) => option.decision)).toEqual([
      'accept',
      'decline',
      'cancel',
    ]);
  });

  it.each([
    ['approval-required', false],
    ['auto-accept-edits', false],
    ['full-access', true],
  ] as const)(
    'in %s Switch keeps the approve key and the connector keeps it: %s',
    async (mode, approved) => {
      await startWithConnector(mode);
      const args = (servers.at(-1) as unknown as { spawnArgs: string[] }).spawnArgs;
      expect(args).toContain('mcp_servers.switch.default_tools_approval_mode="approve"');
      expect(args.includes('mcp_servers.atlassian.default_tools_approval_mode="approve"')).toBe(
        approved
      );
    }
  );
});
