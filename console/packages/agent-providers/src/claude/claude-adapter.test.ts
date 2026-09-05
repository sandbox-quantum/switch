import { describe, expect, it } from 'vitest';
import type { ProviderSessionStartInput, RuntimeMode } from '../adapter';
import { EventRecorder } from '../testing/event-recorder';
import { ClaudeAdapter, installShadowedWarningFilter } from './claude-adapter';
import type { FakeSdk } from './fake-sdk';
import { createFakeSdk } from './fake-sdk';

const SESSION = 'session-1';

function startInput(overrides: Partial<ProviderSessionStartInput> = {}): ProviderSessionStartInput {
  return {
    sessionId: SESSION,
    cwd: '/tmp/switch-claude',
    runtimeMode: 'approval-required',
    env: { PATH: '/usr/bin', HOME: '/home/agent' },
    mcpServers: {},
    ...overrides,
  };
}

async function startSession(runtimeMode: RuntimeMode = 'approval-required') {
  const sdk = createFakeSdk();
  const adapter = new ClaudeAdapter({ query: sdk.query, claudeExecutablePath: '/bin/claude' });
  const recorder = new EventRecorder(adapter);
  const session = await adapter.startSession(startInput({ runtimeMode }));
  return { sdk, adapter, recorder, session };
}

function assistantMessage(id: string, content: Record<string, unknown>[]) {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    uuid: `assistant-${id}`,
    session_id: 'native-1',
    message: { id, role: 'assistant', content },
  };
}

function resultMessage(uuids: string[], overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    user_message_uuid: uuids.at(-1),
    user_message_uuids: uuids,
    terminal_reason: 'completed',
    uuid: `result-${uuids.join('-')}`,
    session_id: 'native-1',
    ...overrides,
  };
}

describe('ClaudeAdapter session lifecycle', () => {
  it('picks the CLI session id itself so a session is usable before init', async () => {
    const { sdk, adapter, recorder, session } = await startSession();
    expect(session.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.provider).toBe('claude');
    expect(sdk.options().sessionId).toBe(session.nativeSessionId);
    const started = await recorder.waitFor('session.started', () => true, 1_000);
    expect(started.nativeSessionId).toBe(session.nativeSessionId);
    expect(adapter.hasSession(SESSION)).toBe(true);
    await recorder.waitFor('session.state.changed', (event) => event.status === 'ready', 1_000);
    expect(recorder.ofType('runtime.warning')).toHaveLength(0);
  });

  it('warns when the CLI reports a different session id than the one requested', async () => {
    const sdk = createFakeSdk();
    const adapter = new ClaudeAdapter({ query: sdk.query, claudeExecutablePath: '/bin/claude' });
    const recorder = new EventRecorder(adapter);
    await adapter.startSession(startInput());
    sdk.latest().emit({
      type: 'system',
      subtype: 'init',
      session_id: 'a-different-id',
      model: 'claude-sonnet-5',
      tools: [],
      mcp_servers: [],
    });
    const warning = await recorder.waitFor('runtime.warning', () => true, 1_000);
    expect(warning.message).toContain('a-different-id');
  });

  it('passes cwd, env, permission mode and MCP servers straight through', async () => {
    const sdk = createFakeSdk();
    const adapter = new ClaudeAdapter({ query: sdk.query, claudeExecutablePath: '/bin/claude' });
    await adapter.startSession(
      startInput({
        runtimeMode: 'full-access',
        systemContext: 'Switch context',
        mcpServers: {
          switch_echo: { transport: 'stdio', command: 'node', args: ['server.mjs'] },
          remote: { transport: 'http', url: 'https://example.invalid/mcp' },
        },
      })
    );
    const options = sdk.options();
    expect(options.cwd).toBe('/tmp/switch-claude');
    expect(options.env).toEqual({ PATH: '/usr/bin', HOME: '/home/agent' });
    expect(options.permissionMode).toBe('bypassPermissions');
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    expect(options.pathToClaudeCodeExecutable).toBe('/bin/claude');
    expect(options.includePartialMessages).toBe(true);
    expect(options.settingSources).toBeUndefined();
    expect(typeof options.canUseTool).toBe('function');
    expect(options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Switch context',
    });
    expect(options.mcpServers).toEqual({
      switch_echo: { type: 'stdio', command: 'node', args: ['server.mjs'] },
      remote: { type: 'http', url: 'https://example.invalid/mcp' },
    });
  });

  it('runs as a named agent definition, and as none when the caller names none', async () => {
    const sdk = createFakeSdk();
    const adapter = new ClaudeAdapter({ query: sdk.query, claudeExecutablePath: '/bin/claude' });
    await adapter.startSession(startInput({ agentName: 'e2e-claude-abc' }));
    expect(sdk.options().agent).toBe('e2e-claude-abc');

    const bare = createFakeSdk();
    const bareAdapter = new ClaudeAdapter({
      query: bare.query,
      claudeExecutablePath: '/bin/claude',
    });
    await bareAdapter.startSession(startInput());
    expect(bare.options().agent).toBeUndefined();
  });

  it('forwards the model and its reasoning effort, ignoring an effort it does not know', async () => {
    const sdk = createFakeSdk();
    const adapter = new ClaudeAdapter({ query: sdk.query, claudeExecutablePath: '/bin/claude' });
    await adapter.startSession(
      startInput({ model: { id: 'claude-sonnet-5', options: { effort: 'high' } } })
    );
    expect(sdk.options().model).toBe('claude-sonnet-5');
    expect(sdk.options().effort).toBe('high');

    const odd = createFakeSdk();
    const oddAdapter = new ClaudeAdapter({ query: odd.query, claudeExecutablePath: '/bin/claude' });
    await oddAdapter.startSession(
      startInput({ model: { id: 'claude-sonnet-5', options: { effort: 'ludicrous' } } })
    );
    expect(odd.options().effort).toBeUndefined();
  });

  it('says so when it falls back to the CLI bundled with the SDK', async () => {
    const sdk = createFakeSdk();
    // No `claude` anywhere on this PATH, and no configured override.
    const adapter = new ClaudeAdapter({ query: sdk.query });
    const recorder = new EventRecorder(adapter);
    await adapter.startSession(startInput({ env: { PATH: '/nonexistent-switch-e2e' } }));
    expect(sdk.options().pathToClaudeCodeExecutable).toBeUndefined();
    const warning = await recorder.waitFor('runtime.warning', () => true, 1_000);
    expect(warning.message).toContain('bundled with the Agent SDK');
  });

  it('maps each runtime mode onto a permission mode', async () => {
    for (const [runtimeMode, permissionMode] of [
      ['approval-required', 'default'],
      ['auto-accept-edits', 'acceptEdits'],
      ['full-access', 'bypassPermissions'],
    ] as const) {
      const sdk = createFakeSdk();
      const adapter = new ClaudeAdapter({ query: sdk.query, claudeExecutablePath: '/bin/claude' });
      await adapter.startSession(startInput({ runtimeMode }));
      expect(sdk.options().permissionMode).toBe(permissionMode);
    }
  });

  it('drops the SDK’s shadowed-callback warning and leaves other warnings alone', async () => {
    // The callback is registered under bypassPermissions on purpose — it is
    // what makes the CLI offer AskUserQuestion — so the SDK's warning about it
    // is filtered rather than obeyed.
    const seen: string[] = [];
    const collect = (warning: Error & { code?: string }) => seen.push(warning.code ?? '');
    process.on('warning', collect);
    const uninstall = installShadowedWarningFilter();
    try {
      process.emitWarning('shadowed', { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' });
      process.emitWarning('unrelated', { code: 'SOMETHING_ELSE' });
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      uninstall();
      process.removeListener('warning', collect);
    }
    expect(seen).toEqual(['SOMETHING_ELSE']);
  });

  it('resumes a native session instead of picking a new id', async () => {
    const sdk = createFakeSdk();
    const adapter = new ClaudeAdapter({ query: sdk.query, claudeExecutablePath: '/bin/claude' });
    const session = await adapter.startSession(
      startInput({ resume: { nativeSessionId: 'earlier' } })
    );
    expect(sdk.options().resume).toBe('earlier');
    expect(sdk.options().sessionId).toBeUndefined();
    expect(session.nativeSessionId).toBe('earlier');
  });

  it('stops the session, closes the query and forgets it', async () => {
    const { sdk, adapter, recorder } = await startSession();
    await adapter.stopSession(SESSION);
    const exited = await recorder.waitFor('session.exited', () => true, 1_000);
    expect(exited.reason).toBe('Session stopped.');
    expect(sdk.latest().closed).toBe(true);
    expect(adapter.hasSession(SESSION)).toBe(false);
    await expect(adapter.stopSession(SESSION)).rejects.toThrow(/Unknown session/);
  });
});

describe('ClaudeAdapter event translation', () => {
  it('streams assistant text as content deltas and closes the item', async () => {
    const { sdk, adapter, recorder } = await startSession();
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'hi' });
    const query = sdk.latest();

    query.emit({
      type: 'stream_event',
      parent_tool_use_id: null,
      uuid: 'se-1',
      session_id: 'native-1',
      event: { type: 'message_start', message: { id: 'msg_1' } },
    });
    query.emit({
      type: 'stream_event',
      parent_tool_use_id: null,
      uuid: 'se-2',
      session_id: 'native-1',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    for (const delta of ['Hello', ' world']) {
      query.emit({
        type: 'stream_event',
        parent_tool_use_id: null,
        uuid: `se-${delta}`,
        session_id: 'native-1',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: delta },
        },
      });
    }
    query.emit({
      type: 'stream_event',
      parent_tool_use_id: null,
      uuid: 'se-3',
      session_id: 'native-1',
      event: { type: 'content_block_stop', index: 0 },
    });
    query.emit(assistantMessage('msg_1', [{ type: 'text', text: 'Hello world' }]));

    const completed = await recorder.waitFor(
      'item.completed',
      (event) => event.item.type === 'assistant_message',
      1_000
    );
    expect(completed.item.id).toBe('msg_1#0');
    expect(completed.item.text).toBe('Hello world');
    expect(recorder.assistantText('turn-1')).toBe('Hello world');
    expect(recorder.ofType('content.delta').map((event) => event.itemId)).toEqual([
      'msg_1#0',
      'msg_1#0',
    ]);
    expect(
      recorder.ofType('item.completed').filter((e) => e.item.type === 'assistant_message')
    ).toHaveLength(1);
  });

  it('falls back to the whole assistant message when no partials arrived', async () => {
    const { sdk, adapter, recorder } = await startSession();
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'hi' });
    sdk.latest().emit(assistantMessage('msg_2', [{ type: 'text', text: 'no stream' }]));
    const completed = await recorder.waitFor('item.completed', () => true, 1_000);
    expect(completed.item.type).toBe('assistant_message');
    expect(completed.item.text).toBe('no stream');
    expect(recorder.assistantText('turn-1')).toBe('no stream');
  });

  it('maps tool_use blocks onto item types and closes them on tool_result', async () => {
    const cases = [
      { name: 'Bash', input: { command: 'ls -la' }, type: 'command_execution', title: 'ls -la' },
      {
        name: 'Write',
        input: { file_path: '/tmp/a.txt' },
        type: 'file_change',
        title: 'Write /tmp/a.txt',
      },
      {
        name: 'mcp__switch_echo__switch_echo',
        input: { text: 'hi' },
        type: 'mcp_tool_call',
        title: 'mcp__switch_echo__switch_echo',
      },
      { name: 'WebSearch', input: { query: 'switch' }, type: 'web_search', title: 'switch' },
      {
        name: 'Agent',
        input: { description: 'read the readme', subagent_type: 'Explore' },
        type: 'subagent',
        title: 'read the readme',
      },
      { name: 'TodoWrite', input: {}, type: 'tool_call', title: 'TodoWrite' },
    ] as const;

    const { sdk, adapter, recorder } = await startSession();
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    const query = sdk.latest();
    query.emit(
      assistantMessage(
        'msg_3',
        cases.map((entry, index) => ({
          type: 'tool_use',
          id: `tool-${index}`,
          name: entry.name,
          input: entry.input,
        }))
      )
    );

    await recorder.waitFor('item.started', (event) => event.item.id === 'tool-5', 1_000);
    const started = recorder.ofType('item.started');
    expect(started.map((event) => event.item.type)).toEqual(cases.map((entry) => entry.type));
    expect(started.map((event) => event.item.title)).toEqual(cases.map((entry) => entry.title));
    expect(started.map((event) => event.item.status)).toEqual(cases.map(() => 'in_progress'));
    expect(started[4]?.item.toolName).toBe('Explore');

    query.emit({
      type: 'user',
      parent_tool_use_id: null,
      uuid: 'user-1',
      session_id: 'native-1',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-0', content: 'total 0' },
          { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'denied' },
        ],
      },
    });

    await recorder.waitFor('item.completed', (event) => event.item.id === 'tool-1', 1_000);
    const completed = recorder.ofType('item.completed');
    expect(completed.map((event) => [event.item.id, event.item.status, event.item.text])).toEqual([
      ['tool-0', 'completed', 'total 0'],
      ['tool-1', 'failed', 'denied'],
    ]);
  });

  it('ignores stream events produced inside a subagent', async () => {
    const { sdk, adapter, recorder } = await startSession();
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    sdk.latest().emit({
      type: 'stream_event',
      parent_tool_use_id: 'tool-0',
      uuid: 'se-sub',
      session_id: 'native-1',
      event: { type: 'message_start', message: { id: 'msg_sub' } },
    });
    sdk.latest().emit(assistantMessage('msg_4', [{ type: 'text', text: 'main' }]));
    await recorder.waitFor('item.completed', () => true, 1_000);
    expect(recorder.ofType('content.delta')).toHaveLength(0);
  });
});

describe('ClaudeAdapter turn attribution', () => {
  it('opens a turn on send and closes it on the matching result', async () => {
    const { sdk, adapter, recorder } = await startSession();
    const result = await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'hi' });
    expect(result.turnId).toBe('turn-1');
    expect(result.steeredInto).toBeUndefined();
    await recorder.waitFor('turn.started', (event) => event.turnId === 'turn-1', 1_000);

    const [sent] = await sdk.latest().waitForSent(1);
    expect(sent?.message.content).toBe('hi');
    sdk.latest().emit(resultMessage([String(sent?.uuid)]));

    const done = await recorder.waitFor('turn.completed', () => true, 1_000);
    expect(done.turnId).toBe('turn-1');
    expect(done.outcome).toBe('completed');
  });

  it('steers a mid-turn send into the running turn and waits for its result', async () => {
    const { sdk, adapter, recorder } = await startSession();
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'count' });
    const query = sdk.latest();
    const [first] = await query.waitForSent(1);

    const steer = await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-2', text: 'stop' });
    expect(steer.turnId).toBe('turn-2');
    expect(steer.steeredInto).toBe('turn-1');
    const sent = await query.waitForSent(2);
    expect(recorder.ofType('turn.started')).toHaveLength(1);

    query.emit(resultMessage([String(first?.uuid)]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recorder.ofType('turn.completed')).toHaveLength(0);

    query.emit(resultMessage([String(sent[1]?.uuid)]));
    const done = await recorder.waitFor('turn.completed', () => true, 1_000);
    expect(done.turnId).toBe('turn-1');
    expect(done.outcome).toBe('completed');
  });

  it('closes the turn on one result when the CLI folds both sends into it', async () => {
    const { sdk, adapter, recorder } = await startSession();
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'count' });
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-2', text: 'stop' });
    const query = sdk.latest();
    const sent = await query.waitForSent(2);
    query.emit(resultMessage(sent.map((message) => String(message.uuid))));
    const done = await recorder.waitFor('turn.completed', () => true, 1_000);
    expect(done.turnId).toBe('turn-1');
    expect(recorder.ofType('turn.completed')).toHaveLength(1);
  });

  it('reports an aborted result as an interrupted turn', async () => {
    const { sdk, adapter, recorder } = await startSession();
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'count' });
    const query = sdk.latest();
    const [sent] = await query.waitForSent(1);
    await adapter.interruptTurn(SESSION);
    expect(query.interruptCount).toBe(1);
    query.emit(
      resultMessage([String(sent?.uuid)], {
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_streaming',
        errors: ['[ede_diagnostic] result_type=user'],
      })
    );
    const done = await recorder.waitFor('turn.completed', () => true, 1_000);
    expect(done.outcome).toBe('interrupted');
  });

  it('reports a failed result as an error turn and a runtime error', async () => {
    const { sdk, adapter, recorder } = await startSession();
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    const query = sdk.latest();
    const [sent] = await query.waitForSent(1);
    query.emit(
      resultMessage([String(sent?.uuid)], {
        subtype: 'error_max_turns',
        is_error: true,
        terminal_reason: 'max_turns',
        errors: ['[ede_diagnostic] noise', 'Reached the turn limit'],
      })
    );
    const done = await recorder.waitFor('turn.completed', () => true, 1_000);
    expect(done.outcome).toBe('error');
    expect(done.message).toBe('Reached the turn limit');
    expect(recorder.ofType('runtime.error')[0]?.message).toBe('Reached the turn limit');
  });

  it('ignores a result for sends this adapter never made', async () => {
    const { sdk, adapter, recorder } = await startSession();
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    sdk.latest().emit(resultMessage(['someone-elses-send']));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recorder.ofType('turn.completed')).toHaveLength(0);
  });

  it('closes a running turn as interrupted when the session stops', async () => {
    const { adapter, recorder } = await startSession();
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    await adapter.stopSession(SESSION);
    const done = await recorder.waitFor('turn.completed', () => true, 1_000);
    expect(done.outcome).toBe('interrupted');
  });

  it('rejects sends for an unknown session', async () => {
    const { adapter } = await startSession();
    await expect(adapter.sendTurn({ sessionId: 'nope', turnId: 't', text: 'hi' })).rejects.toThrow(
      /Unknown session/
    );
  });
});

describe('ClaudeAdapter approvals', () => {
  const toolOptions = (signal: AbortSignal, extra: Record<string, unknown> = {}) => ({
    signal,
    toolUseID: 'tool-approval-1',
    requestId: 'control-1',
    ...extra,
  });

  it('opens a request, resolves it on accept and allows the tool', async () => {
    const { sdk, adapter, recorder } = await startSession();
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    const controller = new AbortController();
    const decision = sdk.canUseTool()(
      'Bash',
      { command: 'echo hi' },
      toolOptions(controller.signal, { title: 'Claude wants to run echo hi' })
    );

    const opened = await recorder.waitFor('request.opened', () => true, 1_000);
    expect(opened.requestType).toBe('command_execution_approval');
    expect(opened.turnId).toBe('turn-1');
    expect(opened.title).toBe('Claude wants to run echo hi');
    expect(opened.options.map((option) => option.decision)).toEqual([
      'accept',
      'acceptForSession',
      'decline',
    ]);

    await adapter.respondToRequest(SESSION, opened.requestId, 'accept');
    expect(await decision).toEqual({ behavior: 'allow' });
    const resolved = await recorder.waitFor('request.resolved', () => true, 1_000);
    expect(resolved.decision).toBe('accept');
  });

  it('rescopes the CLI suggestions to the session on acceptForSession', async () => {
    const { sdk, adapter, recorder } = await startSession();
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    const controller = new AbortController();
    const decision = sdk.canUseTool()(
      'Bash',
      { command: 'echo hi' },
      toolOptions(controller.signal, {
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'echo:*' }],
            behavior: 'allow',
            destination: 'userSettings',
          },
        ],
      })
    );
    const opened = await recorder.waitFor('request.opened', () => true, 1_000);
    await adapter.respondToRequest(SESSION, opened.requestId, 'acceptForSession');
    expect(await decision).toEqual({
      behavior: 'allow',
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'echo:*' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    });
  });

  it('denies the tool on decline', async () => {
    const { sdk, adapter, recorder } = await startSession();
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    const controller = new AbortController();
    const decision = sdk.canUseTool()(
      'Write',
      { file_path: '/tmp/x' },
      toolOptions(controller.signal)
    );
    const opened = await recorder.waitFor('request.opened', () => true, 1_000);
    expect(opened.requestType).toBe('file_change_approval');
    await adapter.respondToRequest(SESSION, opened.requestId, 'decline');
    const result = await decision;
    expect(result?.behavior).toBe('deny');
  });

  it('never asks about a tool of an MCP server the caller registered', async () => {
    // A session's MCP servers are the ones the caller put there for it to use —
    // for Switch Console the room protocol. Asking a human for permission to
    // speak in the room leaves the session unable to answer the room at all,
    // including to ask.
    const sdk = createFakeSdk();
    const adapter = new ClaudeAdapter({ query: sdk.query, claudeExecutablePath: '/bin/claude' });
    const recorder = new EventRecorder(adapter);
    await adapter.startSession(
      startInput({
        mcpServers: {
          'switch:rooms': { transport: 'stdio', command: 'node', args: ['server.mjs'] },
        },
      })
    );
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    const controller = new AbortController();
    const allowed = await sdk.canUseTool()(
      // The server name is folded the way Claude Code names an MCP tool.
      'mcp__switch_rooms__post_message',
      { room_id: 'r' },
      toolOptions(controller.signal)
    );
    expect(allowed?.behavior).toBe('allow');
    expect(recorder.ofType('request.opened')).toEqual([]);

    // A tool that is not one of theirs still asks.
    void sdk.canUseTool()('Bash', { command: 'ls' }, toolOptions(controller.signal));
    await recorder.waitFor('request.opened', () => true, 1_000);
  });

  it('registers the permission callback in full access too, where AskUserQuestion needs it', async () => {
    // Registering it is what makes Claude Code offer `AskUserQuestion` at all,
    // so it goes on every mode; `bypassPermissions` settles everything else
    // before the callback is consulted.
    const { sdk } = await startSession('full-access');
    expect(typeof sdk.options().canUseTool).toBe('function');
    expect(sdk.options().permissionMode).toBe('bypassPermissions');
    expect(sdk.options().allowDangerouslySkipPermissions).toBe(true);
  });

  it('allows anything that still reaches the callback in full access', async () => {
    const { sdk, adapter, recorder } = await startSession('full-access');
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    const allowed = await sdk.canUseTool()(
      'Bash',
      { command: 'ls' },
      toolOptions(new AbortController().signal)
    );
    expect(allowed).toEqual({ behavior: 'allow' });
    expect(recorder.ofType('request.opened')).toEqual([]);
  });

  it('takes the decision back from a hook that would settle it, except in full access', async () => {
    // Another hook's `allow` settles a permission outright and `canUseTool` is
    // never called — which is how the Switch connector plugin's mediation hook
    // ran shell commands with nobody ever offered the approval card.
    const { sdk } = await startSession();
    const entry = sdk.options().hooks?.PreToolUse?.find((group) => group.matcher?.includes('Bash'));
    expect(entry).toBeDefined();
    const decision = await entry!.hooks[0](
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} } as never,
      undefined,
      { signal: new AbortController().signal }
    );
    expect(decision).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    });

    // In full access nothing is asked, so nothing is reclaimed either.
    const full = await startSession('full-access');
    expect(full.sdk.options().hooks).toBeUndefined();
  });

  it('cancels an open request when the session stops', async () => {
    const { sdk, adapter, recorder } = await startSession();
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    const controller = new AbortController();
    const decision = sdk.canUseTool()(
      'Bash',
      { command: 'rm -rf /' },
      toolOptions(controller.signal)
    );
    await recorder.waitFor('request.opened', () => true, 1_000);
    await adapter.stopSession(SESSION);
    const result = await decision;
    expect(result?.behavior).toBe('deny');
    expect(recorder.ofType('request.resolved')[0]?.decision).toBe('cancel');
  });

  it('rejects an answer for an unknown request', async () => {
    const { adapter } = await startSession();
    await expect(adapter.respondToRequest(SESSION, 'nope', 'accept')).rejects.toThrow(
      /Unknown request/
    );
  });
});

describe('ClaudeAdapter user input', () => {
  const askInput = {
    questions: [
      {
        question: 'Which color?',
        header: 'Color',
        multiSelect: false,
        options: [
          { label: 'red', description: 'the red one' },
          { label: 'green', description: 'the green one' },
        ],
      },
    ],
  };

  function askUserQuestion(sdk: FakeSdk, controller: AbortController, toolUseId: string) {
    return sdk.canUseTool()('AskUserQuestion', askInput, {
      signal: controller.signal,
      toolUseID: toolUseId,
      requestId: `control-${toolUseId}`,
    });
  }

  it('surfaces AskUserQuestion and answers it keyed by question text', async () => {
    const { sdk, adapter, recorder } = await startSession('full-access');
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    const decision = askUserQuestion(sdk, new AbortController(), 'ask-1');

    const requested = await recorder.waitFor('user-input.requested', () => true, 1_000);
    expect(requested.turnId).toBe('turn-1');
    expect(requested.requestId).toBe('ask-1');
    expect(requested.questions).toEqual([
      {
        id: 'q0',
        header: 'Color',
        question: 'Which color?',
        options: [
          { label: 'red', value: 'red', description: 'the red one' },
          { label: 'green', value: 'green', description: 'the green one' },
        ],
        multiSelect: false,
        allowCustomAnswer: true,
      },
    ]);

    await adapter.respondToUserInput(SESSION, requested.requestId, { q0: 'green' });
    expect(await decision).toEqual({
      behavior: 'allow',
      updatedInput: { questions: askInput.questions, answers: { 'Which color?': 'green' } },
    });
    await recorder.waitFor('user-input.resolved', () => true, 1_000);
  });

  it('joins a multi-select answer the way the tool expects', async () => {
    const { sdk, adapter, recorder } = await startSession('full-access');
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    const decision = askUserQuestion(sdk, new AbortController(), 'ask-2');
    const requested = await recorder.waitFor('user-input.requested', () => true, 1_000);
    await adapter.respondToUserInput(SESSION, requested.requestId, { q0: ['red', 'green'] });
    expect(await decision).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which color?': 'red, green' } },
    });
  });

  it('denies the tool when the CLI aborts the question', async () => {
    const { sdk, adapter, recorder } = await startSession('full-access');
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    const controller = new AbortController();
    const decision = askUserQuestion(sdk, controller, 'ask-3');
    await recorder.waitFor('user-input.requested', () => true, 1_000);
    controller.abort();
    expect(await decision).toMatchObject({ behavior: 'deny' });
  });

  it('asks in a mode that prompts as well, without opening an approval card', async () => {
    const { sdk, adapter, recorder } = await startSession('approval-required');
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    const decision = askUserQuestion(sdk, new AbortController(), 'ask-5');
    const requested = await recorder.waitFor('user-input.requested', () => true, 1_000);
    expect(recorder.ofType('request.opened')).toEqual([]);
    await adapter.respondToUserInput(SESSION, requested.requestId, { q0: 'red' });
    expect(await decision).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which color?': 'red' } },
    });
  });

  it('answers an open question with nothing when the session stops', async () => {
    const { sdk, adapter, recorder } = await startSession('full-access');
    await adapter.sendTurn({ sessionId: SESSION, turnId: 'turn-1', text: 'go' });
    const decision = askUserQuestion(sdk, new AbortController(), 'ask-4');
    await recorder.waitFor('user-input.requested', () => true, 1_000);
    await adapter.stopSession(SESSION);
    expect(await decision).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: {} },
    });
    await recorder.waitFor('user-input.resolved', () => true, 1_000);
  });

  it('rejects an answer for an unknown question', async () => {
    const { adapter } = await startSession();
    await expect(adapter.respondToUserInput(SESSION, 'nope', {})).rejects.toThrow(
      /Unknown user input/
    );
  });
});

describe('ClaudeAdapter model switching', () => {
  it('forwards setModel to the live query', async () => {
    const { sdk, adapter } = await startSession();
    await adapter.setModel(SESSION, { id: 'claude-opus-4-8' });
    expect(sdk.latest().setModelCalls).toEqual(['claude-opus-4-8']);
  });

  it('sends the model id and effort at start', async () => {
    const sdk = createFakeSdk();
    const adapter = new ClaudeAdapter({ query: sdk.query, claudeExecutablePath: '/bin/claude' });
    await adapter.startSession(
      startInput({ model: { id: 'claude-sonnet-5', options: { effort: 'high' } } })
    );
    expect(sdk.options().model).toBe('claude-sonnet-5');
    expect(sdk.options().effort).toBe('high');
  });

  it('drops an effort the SDK does not define', async () => {
    const sdk = createFakeSdk();
    const adapter = new ClaudeAdapter({ query: sdk.query, claudeExecutablePath: '/bin/claude' });
    await adapter.startSession(
      startInput({ model: { id: 'claude-sonnet-5', options: { effort: 'ludicrous' } } })
    );
    expect(sdk.options().effort).toBeUndefined();
  });
});
