import { describe, expect, it } from 'vitest';
import type { ProviderSessionStartInput, RuntimeMode } from '../adapter';
import { EventRecorder } from '../testing/event-recorder';
import { mcpConfigFor, parseModelId, permissionConfigFor, permissionRulesFor } from './config';
import {
  createFakeTransport,
  type FakeSession,
  type FakeTransport,
  messageUpdated,
  opencodeEvent,
  sessionStatus,
  textDelta,
  textPart,
  toolPart,
} from './fake-transport';
import {
  createOpencodeAdapter,
  fromPermissionReply,
  type OpencodeAdapter,
  permissionTitle,
  toolItemType,
  toPermissionReply,
  toQuestionAnswers,
  toRequestType,
} from './opencode-adapter';

const NATIVE = 'ses_fake';

function startInput(overrides: Partial<ProviderSessionStartInput> = {}): ProviderSessionStartInput {
  return {
    sessionId: 'switch-session',
    cwd: '/tmp/switch-opencode',
    runtimeMode: 'full-access',
    env: { PATH: '/usr/bin', HOME: '/home/switch' },
    mcpServers: {},
    model: { id: 'opencode/big-pickle' },
    ...overrides,
  };
}

async function setup(
  runtimeMode: RuntimeMode = 'full-access',
  overrides: Partial<ProviderSessionStartInput> = {}
): Promise<{
  adapter: OpencodeAdapter;
  transport: FakeTransport;
  session: FakeSession;
  recorder: EventRecorder;
}> {
  const transport = createFakeTransport(NATIVE);
  const adapter = createOpencodeAdapter({ transport });
  const recorder = new EventRecorder(adapter);
  await adapter.startSession(startInput({ runtimeMode, ...overrides }));
  return { adapter, transport, session: transport.last(), recorder };
}

describe('OpencodeAdapter turn lifecycle', () => {
  it('completes a turn on the idle that follows the prompt busy', async () => {
    const { adapter, session, recorder } = await setup();
    await adapter.sendTurn({ sessionId: 'switch-session', turnId: 't1', text: 'hello' });
    await recorder.waitFor('turn.started', (event) => event.turnId === 't1', 1_000);

    session.push(sessionStatus(NATIVE, 'busy'));
    session.push(messageUpdated(NATIVE, 'msg1', 'assistant'));
    session.push(textPart(NATIVE, 'msg1', 'prt1', ''));
    session.push(textDelta(NATIVE, 'msg1', 'prt1', 'hi there'));
    session.push(textPart(NATIVE, 'msg1', 'prt1', 'hi there', true));
    session.push(sessionStatus(NATIVE, 'idle'));

    const done = await recorder.waitFor('turn.completed', (event) => event.turnId === 't1', 1_000);
    expect(done.outcome).toBe('completed');
    expect(recorder.assistantText('t1')).toBe('hi there');
    expect(recorder.ofType('turn.completed')).toHaveLength(1);
  });

  it('ignores an idle that OpenCode queued before the prompt was admitted', async () => {
    const { adapter, session, recorder } = await setup();
    await adapter.sendTurn({ sessionId: 'switch-session', turnId: 't1', text: 'hello' });

    session.push(sessionStatus(NATIVE, 'idle'));
    session.push(sessionStatus(NATIVE, 'busy'));
    await recorder.waitFor('session.state.changed', (event) => event.status === 'running', 1_000);
    expect(recorder.ofType('turn.completed')).toHaveLength(0);

    session.push(sessionStatus(NATIVE, 'idle'));
    const done = await recorder.waitFor('turn.completed', (event) => event.turnId === 't1', 1_000);
    expect(done.outcome).toBe('completed');
    expect(recorder.ofType('turn.completed')).toHaveLength(1);
  });

  it('steers a mid-turn message into the running turn and completes it once', async () => {
    const { adapter, session, recorder } = await setup();
    await adapter.sendTurn({ sessionId: 'switch-session', turnId: 't1', text: 'count' });
    session.push(sessionStatus(NATIVE, 'busy'));
    await recorder.waitFor('session.state.changed', (event) => event.status === 'running', 1_000);

    const steer = await adapter.sendTurn({
      sessionId: 'switch-session',
      turnId: 't2',
      text: 'stop counting',
    });
    expect(steer).toEqual({ turnId: 't2', steeredInto: 't1' });
    expect(recorder.ofType('turn.started').map((event) => event.turnId)).toEqual(['t1']);

    // The steer re-arms the busy gate, so an idle already in flight is ignored.
    session.push(sessionStatus(NATIVE, 'idle'));
    session.push(sessionStatus(NATIVE, 'busy'));
    await recorder.waitFor('session.state.changed', (event) => event.status === 'running', 1_000);
    expect(recorder.ofType('turn.completed')).toHaveLength(0);

    session.push(sessionStatus(NATIVE, 'idle'));
    const done = await recorder.waitFor('turn.completed', () => true, 1_000);
    expect(done.turnId).toBe('t1');
    expect(recorder.ofType('turn.completed')).toHaveLength(1);
  });

  it('reports an interrupt once and swallows the abort error OpenCode echoes back', async () => {
    const { adapter, session, recorder } = await setup();
    await adapter.sendTurn({ sessionId: 'switch-session', turnId: 't1', text: 'count' });
    session.push(sessionStatus(NATIVE, 'busy'));
    await recorder.waitFor('session.state.changed', (event) => event.status === 'running', 1_000);

    await adapter.interruptTurn('switch-session');
    const done = await recorder.waitFor('turn.completed', (event) => event.turnId === 't1', 1_000);
    expect(done.outcome).toBe('interrupted');
    expect(session.calls.some((call) => call.method === 'abort')).toBe(true);

    session.push(
      opencodeEvent('session.error', {
        sessionID: NATIVE,
        error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      })
    );
    session.push(sessionStatus(NATIVE, 'idle'));
    session.push(sessionStatus(NATIVE, 'busy'));
    await recorder.waitFor('session.state.changed', (event) => event.status === 'running', 1_000);
    expect(recorder.ofType('runtime.error')).toHaveLength(0);
    expect(recorder.ofType('turn.completed')).toHaveLength(1);
  });

  it('fails the turn when the prompt is rejected', async () => {
    const { adapter, session, recorder } = await setup();
    session.promptRejection = new Error('prompt rejected');
    await expect(
      adapter.sendTurn({ sessionId: 'switch-session', turnId: 't1', text: 'hello' })
    ).rejects.toThrow(/prompt was rejected/);
    const done = await recorder.waitFor('turn.completed', (event) => event.turnId === 't1', 1_000);
    expect(done.outcome).toBe('error');
  });

  it('surfaces a session error as a runtime error and fails the turn', async () => {
    const { adapter, session, recorder } = await setup();
    await adapter.sendTurn({ sessionId: 'switch-session', turnId: 't1', text: 'hello' });
    session.push(sessionStatus(NATIVE, 'busy'));
    session.push(
      opencodeEvent('session.error', {
        sessionID: NATIVE,
        error: { name: 'ApiError', data: { message: 'upstream exploded' } },
      })
    );
    const done = await recorder.waitFor('turn.completed', (event) => event.turnId === 't1', 1_000);
    expect(done.outcome).toBe('error');
    const failure = await recorder.waitFor('runtime.error', () => true, 1_000);
    expect(failure.message).toContain('upstream exploded');
  });
});

describe('OpencodeAdapter item translation', () => {
  it('maps tool parts onto the shared item vocabulary', async () => {
    const { adapter, session, recorder } = await setup('full-access', {
      mcpServers: {
        switch_echo: { transport: 'stdio', command: 'node', args: ['echo.mjs'] },
      },
    });
    await adapter.sendTurn({ sessionId: 'switch-session', turnId: 't1', text: 'work' });
    session.push(sessionStatus(NATIVE, 'busy'));
    session.push(messageUpdated(NATIVE, 'msg1', 'assistant'));
    session.push(
      toolPart(NATIVE, 'msg1', 'c1', 'bash', {
        status: 'running',
        input: { command: 'ls -la' },
        time: { start: 0 },
      })
    );
    session.push(
      toolPart(NATIVE, 'msg1', 'c2', 'task', {
        status: 'pending',
        input: {},
        raw: '',
      })
    );
    session.push(
      toolPart(NATIVE, 'msg1', 'c2', 'task', {
        status: 'completed',
        input: { description: 'read the readme' },
        output: 'first line',
        title: 'read the readme',
        metadata: {},
        time: { start: 0, end: 1 },
      })
    );
    session.push(
      toolPart(NATIVE, 'msg1', 'c3', 'switch_echo_switch_echo', {
        status: 'completed',
        input: { text: 'hi' },
        output: 'hi',
        title: 'echo',
        metadata: {},
        time: { start: 0, end: 1 },
      })
    );

    const mcp = await recorder.waitFor(
      'item.completed',
      (event) => event.item.type === 'mcp_tool_call',
      1_000
    );
    expect(mcp.item.toolName).toBe('switch_echo_switch_echo');

    const started = recorder.ofType('item.started');
    expect(started.find((event) => event.item.id === 'c1')?.item).toMatchObject({
      type: 'command_execution',
      title: 'ls -la',
    });
    const subagentStart = started.find((event) => event.item.id === 'c2');
    expect(subagentStart?.item.type).toBe('subagent');
    expect(subagentStart?.item.title.length).toBeGreaterThan(0);
    const subagentDone = recorder.ofType('item.completed').find((event) => event.item.id === 'c2');
    expect(subagentDone?.item.status).toBe('completed');
  });

  it('emits assistant text but not reasoning as content deltas', async () => {
    const { adapter, session, recorder } = await setup();
    await adapter.sendTurn({ sessionId: 'switch-session', turnId: 't1', text: 'think' });
    session.push(sessionStatus(NATIVE, 'busy'));
    session.push(messageUpdated(NATIVE, 'msg1', 'assistant'));
    session.push(
      opencodeEvent('message.part.updated', {
        sessionID: NATIVE,
        time: 0,
        part: {
          id: 'prt_reason',
          sessionID: NATIVE,
          messageID: 'msg1',
          type: 'reasoning',
          text: 'pondering',
          time: { start: 0, end: 1 },
        },
      })
    );
    session.push(textPart(NATIVE, 'msg1', 'prt_text', ''));
    session.push(textDelta(NATIVE, 'msg1', 'prt_text', 'answer'));
    await recorder.waitFor('content.delta', () => true, 1_000);

    expect(recorder.assistantText('t1')).toBe('answer');
    expect(recorder.ofType('item.completed').map((event) => event.item.type)).toContain(
      'reasoning'
    );
  });

  it('re-sends only the tail when OpenCode replays whole text after deltas', async () => {
    const { adapter, session, recorder } = await setup();
    await adapter.sendTurn({ sessionId: 'switch-session', turnId: 't1', text: 'hi' });
    session.push(sessionStatus(NATIVE, 'busy'));
    session.push(messageUpdated(NATIVE, 'msg1', 'assistant'));
    session.push(textPart(NATIVE, 'msg1', 'prt1', ''));
    session.push(textDelta(NATIVE, 'msg1', 'prt1', 'one '));
    session.push(textPart(NATIVE, 'msg1', 'prt1', 'one two', true));
    await recorder.waitFor('item.completed', (event) => event.item.id === 'prt1', 1_000);
    expect(recorder.assistantText('t1')).toBe('one two');
  });

  it('ignores events for a session other than its own', async () => {
    const { adapter, session, recorder } = await setup();
    await adapter.sendTurn({ sessionId: 'switch-session', turnId: 't1', text: 'hi' });
    session.push(sessionStatus(NATIVE, 'busy'));
    session.push(sessionStatus('ses_someone_else', 'idle'));
    session.push(messageUpdated(NATIVE, 'msg1', 'assistant'));
    session.push(textPart(NATIVE, 'msg1', 'prt1', 'mine', true));
    await recorder.waitFor('item.completed', () => true, 1_000);
    expect(recorder.ofType('turn.completed')).toHaveLength(0);
  });
});

describe('OpencodeAdapter approvals and questions', () => {
  it('opens a request under approval-required and resolves it from the reply event', async () => {
    const { adapter, session, recorder } = await setup('approval-required');
    await adapter.sendTurn({ sessionId: 'switch-session', turnId: 't1', text: 'run it' });
    session.push(sessionStatus(NATIVE, 'busy'));
    session.push(
      opencodeEvent('permission.asked', {
        id: 'per_1',
        sessionID: NATIVE,
        permission: 'bash',
        patterns: ['echo hi'],
        metadata: { command: 'echo hi' },
        always: ['echo *'],
      })
    );

    const opened = await recorder.waitFor('request.opened', () => true, 1_000);
    expect(opened.requestType).toBe('command_execution_approval');
    expect(opened.title).toBe('echo hi');
    // The pattern already *is* the command; repeating it as the detail put the
    // same string on the card twice, reading as two things to check.
    expect(opened.detail).toBeUndefined();
    expect(opened.options.map((option) => option.decision)).toContain('acceptForSession');

    await adapter.respondToRequest('switch-session', 'per_1', 'acceptForSession');
    expect(session.calls).toContainEqual({
      method: 'replyPermission',
      args: ['per_1', 'always'],
    });

    session.push(
      opencodeEvent('permission.replied', {
        sessionID: NATIVE,
        requestID: 'per_1',
        reply: 'always',
      })
    );
    const resolved = await recorder.waitFor('request.resolved', () => true, 1_000);
    expect(resolved.decision).toBe('acceptForSession');
  });

  it('never opens a request in full access and allows the ask once instead', async () => {
    const { adapter, session, recorder } = await setup('full-access');
    await adapter.sendTurn({ sessionId: 'switch-session', turnId: 't1', text: 'run it' });
    session.push(sessionStatus(NATIVE, 'busy'));
    session.push(
      opencodeEvent('permission.asked', {
        id: 'per_1',
        sessionID: NATIVE,
        permission: 'doom_loop',
        patterns: ['*'],
        metadata: {},
        always: [],
      })
    );
    session.push(sessionStatus(NATIVE, 'idle'));
    await recorder.waitFor('turn.completed', () => true, 1_000);

    expect(recorder.ofType('request.opened')).toHaveLength(0);
    expect(session.calls).toContainEqual({ method: 'replyPermission', args: ['per_1', 'once'] });
  });

  it('answers questions positionally', async () => {
    const { adapter, session, recorder } = await setup();
    await adapter.sendTurn({ sessionId: 'switch-session', turnId: 't1', text: 'ask me' });
    session.push(sessionStatus(NATIVE, 'busy'));
    session.push(
      opencodeEvent('question.asked', {
        id: 'qst_1',
        sessionID: NATIVE,
        questions: [
          {
            question: 'Which color?',
            header: 'Color',
            options: [
              { label: 'red', description: 'warm' },
              { label: 'green', description: 'cool' },
            ],
          },
        ],
      })
    );

    const asked = await recorder.waitFor('user-input.requested', () => true, 1_000);
    expect(asked.questions[0]?.id).toBe('0');
    expect(asked.questions[0]?.options.map((option) => option.value)).toEqual(['red', 'green']);

    await adapter.respondToUserInput('switch-session', 'qst_1', { '0': 'green' });
    expect(session.calls).toContainEqual({
      method: 'replyQuestion',
      args: ['qst_1', [['green']]],
    });

    session.push(
      opencodeEvent('question.replied', {
        sessionID: NATIVE,
        requestID: 'qst_1',
        answers: [['green']],
      })
    );
    await recorder.waitFor('user-input.resolved', (event) => event.requestId === 'qst_1', 1_000);
  });

  it('rejects an answer for a request it never opened', async () => {
    const { adapter } = await setup();
    await expect(
      adapter.respondToRequest('switch-session', 'per_missing', 'accept')
    ).rejects.toThrow(/no pending approval/);
    await expect(adapter.respondToUserInput('switch-session', 'qst_missing', {})).rejects.toThrow(
      /no pending question/
    );
  });
});

describe('OpencodeAdapter session lifecycle', () => {
  it('cancels pending requests and exits on stop', async () => {
    const { adapter, session, recorder } = await setup('approval-required');
    await adapter.sendTurn({ sessionId: 'switch-session', turnId: 't1', text: 'run it' });
    session.push(sessionStatus(NATIVE, 'busy'));
    session.push(
      opencodeEvent('permission.asked', {
        id: 'per_1',
        sessionID: NATIVE,
        permission: 'bash',
        patterns: ['echo hi'],
        metadata: {},
        always: [],
      })
    );
    await recorder.waitFor('request.opened', () => true, 1_000);

    await adapter.stopSession('switch-session');
    const resolved = await recorder.waitFor('request.resolved', () => true, 1_000);
    expect(resolved.decision).toBe('cancel');
    const exited = await recorder.waitFor('session.exited', () => true, 1_000);
    expect(exited.reason).toContain('stopped');
    expect(adapter.hasSession('switch-session')).toBe(false);
  });

  it('emits session.exited when the event stream dies', async () => {
    const { session, recorder } = await setup();
    session.fail('server went away');
    const exited = await recorder.waitFor('session.exited', () => true, 1_000);
    expect(exited.reason).toContain('server went away');
  });

  it('throws for an unknown session rather than returning a flag', async () => {
    const adapter = createOpencodeAdapter({ transport: createFakeTransport() });
    await expect(adapter.sendTurn({ sessionId: 'nope', turnId: 't1', text: 'hi' })).rejects.toThrow(
      /unknown session/
    );
    await expect(adapter.stopSession('nope')).rejects.toThrow(/unknown session/);
  });

  it('passes the resumed native session id through to the transport', async () => {
    const transport = createFakeTransport();
    const adapter = createOpencodeAdapter({ transport });
    const session = await adapter.startSession(
      startInput({ resume: { nativeSessionId: 'ses_prior' } })
    );
    expect(session.nativeSessionId).toBe('ses_prior');
    expect(transport.last().opened.resumeNativeSessionId).toBe('ses_prior');
  });

  it('sends systemContext as the prompt system field', async () => {
    const transport = createFakeTransport();
    const adapter = createOpencodeAdapter({ transport });
    await adapter.startSession(startInput({ systemContext: 'you are in a Switch room' }));
    await adapter.sendTurn({ sessionId: 'switch-session', turnId: 't1', text: 'hi' });
    expect(transport.last().calls[0]).toEqual({
      method: 'prompt',
      args: [
        {
          text: 'hi',
          system: 'you are in a Switch room',
          model: { providerID: 'opencode', modelID: 'big-pickle' },
        },
      ],
    });
  });
});

describe('OpencodeAdapter mappings', () => {
  it('maps decisions onto OpenCode replies in both directions', () => {
    expect(toPermissionReply('accept')).toBe('once');
    expect(toPermissionReply('acceptForSession')).toBe('always');
    expect(toPermissionReply('decline')).toBe('reject');
    expect(toPermissionReply('cancel')).toBe('reject');
    expect(fromPermissionReply('once')).toBe('accept');
    expect(fromPermissionReply('always')).toBe('acceptForSession');
    expect(fromPermissionReply('reject')).toBe('decline');
  });

  it('fills gaps in positional question answers', () => {
    expect(toQuestionAnswers({ '0': 'a', '2': ['b', 'c'] })).toEqual([['a'], [], ['b', 'c']]);
    expect(toQuestionAnswers({})).toEqual([]);
  });

  it('classifies tools and permissions', () => {
    expect(toolItemType('bash', [])).toBe('command_execution');
    expect(toolItemType('write', [])).toBe('file_change');
    expect(toolItemType('task', [])).toBe('subagent');
    expect(toolItemType('webfetch', [])).toBe('web_search');
    expect(toolItemType('switch_echo_ping', ['switch_echo'])).toBe('mcp_tool_call');
    expect(toolItemType('glob', [])).toBe('tool_call');
    expect(toRequestType('bash', [])).toBe('command_execution_approval');
    expect(toRequestType('edit', [])).toBe('file_change_approval');
    expect(toRequestType('external_directory', [])).toBe('directory_access_approval');
    expect(toRequestType('switch_echo_ping', ['switch_echo'])).toBe('mcp_tool_approval');
  });

  it('maps runtime modes onto permissions that never ask in full access', () => {
    expect(permissionConfigFor('full-access', [])['*']).toBe('allow');
    expect(permissionConfigFor('approval-required', [])['bash']).toBe('ask');
    expect(permissionConfigFor('approval-required', [])['edit']).toBe('ask');
    expect(permissionConfigFor('auto-accept-edits', [])['edit']).toBe('allow');
    expect(permissionConfigFor('auto-accept-edits', [])['bash']).toBe('ask');
    expect(permissionRulesFor('full-access', []).every((rule) => rule.action === 'allow')).toBe(
      true
    );
    expect(
      permissionRulesFor('auto-accept-edits', []).find((rule) => rule.permission === 'edit')?.action
    ).toBe('allow');
  });

  it('never asks about a tool from an MCP server the caller registered', () => {
    // A session's MCP servers are the ones Switch put there — for Switch
    // Console, the room protocol. An agent that must ask the room before it may
    // speak in the room cannot deliver the question either.
    expect(permissionConfigFor('approval-required', ['switch'])['switch_*']).toBe('allow');
    expect(
      permissionRulesFor('approval-required', ['switch']).find(
        (rule) => rule.permission === 'switch_*'
      )?.action
    ).toBe('allow');
    expect(permissionConfigFor('approval-required', ['switch'])['bash']).toBe('ask');
  });

  it('titles an approval with the pattern only when the pattern names something', () => {
    expect(permissionTitle('bash', ['rm -rf /'])).toBe('rm -rf /');
    expect(permissionTitle('switch_connect_to_room', ['*'])).toBe('switch_connect_to_room');
    expect(permissionTitle('webfetch', [])).toBe('webfetch');
  });

  it('maps MCP specs onto OpenCode server entries', () => {
    expect(
      mcpConfigFor({
        local: { transport: 'stdio', command: 'node', args: ['s.mjs'], env: { A: '1' } },
        remote: { transport: 'http', url: 'https://example.test/mcp', headers: { A: '1' } },
      })
    ).toEqual({
      local: { type: 'local', command: ['node', 's.mjs'], enabled: true, environment: { A: '1' } },
      remote: {
        type: 'remote',
        url: 'https://example.test/mcp',
        enabled: true,
        headers: { A: '1' },
      },
    });
  });

  it('rejects a model id that is not provider/model', () => {
    expect(parseModelId('opencode/big-pickle')).toEqual({
      providerID: 'opencode',
      modelID: 'big-pickle',
    });
    expect(() => parseModelId('big-pickle')).toThrow(/provider\/model/);
  });
});
