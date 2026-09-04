import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEvent, ProviderRuntimeEventType } from '../events';
import { FakeAppServer, type FakeJsonRpcMessage } from './fake-app-server';

const servers: FakeAppServer[] = [];

vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[]) => {
    const server = new FakeAppServer();
    Object.assign(server, { spawnArgs: args });
    server.replyAlways('initialize', () => ({ userAgent: 'fake' }));
    server.replyAlways('thread/start', () => ({ thread: { id: 'thread-1' } }));
    servers.push(server);
    return server;
  },
}));

const { createCodexAdapter } = await import('./codex-adapter');

const THREAD = 'thread-1';

function eventsOf<T extends ProviderRuntimeEventType>(
  events: ProviderRuntimeEvent[],
  type: T
): Array<Extract<ProviderRuntimeEvent, { type: T }>> {
  return events.filter(
    (event): event is Extract<ProviderRuntimeEvent, { type: T }> => event.type === type
  );
}

async function start(runtimeMode: 'full-access' | 'approval-required' = 'full-access') {
  const adapter = createCodexAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const session = await adapter.startSession({
    sessionId: 'session-1',
    cwd: '/work',
    runtimeMode,
    env: { PATH: '/usr/bin' },
    mcpServers: {},
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
  });

  it('initializes, opens a thread and reports the thread id as the native session', async () => {
    const { server, session, events } = await start();
    expect(session.nativeSessionId).toBe(THREAD);
    expect(eventsOf(events, 'session.started')[0]?.nativeSessionId).toBe(THREAD);
    const threadStart = server.received.find((message) => message.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      cwd: '/work',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
  });

  it('asks for approvals in approval-required mode', async () => {
    const { server } = await start('approval-required');
    const threadStart = server.received.find((message) => message.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    });
  });

  it('carries systemContext as developer instructions', async () => {
    const adapter = createCodexAdapter();
    await adapter.startSession({
      sessionId: 's',
      cwd: '/work',
      runtimeMode: 'full-access',
      env: {},
      mcpServers: {},
      systemContext: 'you are in a Switch room',
    });
    const server = servers.at(-1);
    expect(
      server?.received.find((message) => message.method === 'thread/start')?.params
    ).toMatchObject({ developerInstructions: 'you are in a Switch room' });
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
