import { describe, expect, it } from 'vitest';
import { fakePiTextTurn } from './fake-pi';
import { piItemType, PiTurnMapper, type PiTurnEvent } from './pi-events';
import type { PiRpcEvent } from './pi-rpc';

/**
 * READY §5 (`pi-events.test.ts`), SC6 (`10_implementation_plan.md:78`): `agent_end` → retry →
 * `agent_settled` gives one `turn.completed`; item types; `declined`; usage.
 *
 * The sequences are Pi 1.4.0's own, recorded without a real model or with the spike's, cut to
 * the fields the mapper reads (sources in each helper): `fakePiTextTurn` (`./fake-pi.ts`),
 * `evidence/spike/r2-4-retry/rpc-run2.jsonl`, `evidence/spike/r2-1-gate/rpc-run1.jsonl`,
 * `evidence/spike/r2-3-abort/rpc-run1.jsonl`.
 */

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
const OVERLOADED =
  '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

function assistant(
  model: string,
  content: unknown[],
  stopReason: string,
  usage: object,
  extra: object = {}
) {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'fake',
    model,
    usage,
    stopReason,
    ...extra,
  };
}
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const update = (assistantMessageEvent: object): PiRpcEvent => ({
  type: 'message_update',
  assistantMessageEvent,
});

/** A failed attempt and its retry (`r2-4-retry/rpc-run2.jsonl:4-26`). */
function retryThenOk(): PiRpcEvent[] {
  const failed = assistant('fake-model', [], 'error', ZERO, { errorMessage: OVERLOADED });
  const ok = assistant('fake-model', [{ type: 'text', text: 'ok' }], 'stop', {
    input: 11,
    output: 7,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 18,
  });
  return [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: user('retry test') },
    { type: 'message_end', message: user('retry test') },
    { type: 'message_start', message: failed },
    { type: 'message_end', message: failed },
    { type: 'turn_end', message: failed },
    { type: 'agent_end', messages: [failed], willRetry: true },
    {
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: OVERLOADED,
    },
    {
      type: 'entry_appended',
      entry: { type: 'context_edit', id: '2bd8f610', targetId: 'f794bf26' },
    },
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'message_start',
      message: { ...ok, content: [{ type: 'text', text: '', index: 0 }], stopReason: 'pending' },
    },
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'ok' }),
    update({ type: 'text_end', contentIndex: 0, content: 'ok' }),
    { type: 'message_end', message: ok },
    { type: 'auto_retry_end', success: true, attempt: 1 },
    { type: 'turn_end', message: ok },
    { type: 'agent_end', messages: [ok], willRetry: false },
    { type: 'agent_settled', aborted: false },
  ];
}

/** Three retries that all fail (`r2-4-retry/rpc-run2.jsonl:30-63`). */
function retryExhausted(): PiRpcEvent[] {
  const failed = assistant('fake-model', [], 'error', ZERO, { errorMessage: OVERLOADED });
  const attempt = (): PiRpcEvent[] => [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: failed },
    { type: 'message_end', message: failed },
    { type: 'turn_end', message: failed },
    { type: 'agent_end', messages: [failed], willRetry: true },
  ];
  const events: PiRpcEvent[] = [];
  for (let n = 1; n <= 3; n += 1) {
    events.push(...attempt());
    events.push({
      type: 'auto_retry_start',
      attempt: n,
      maxAttempts: 3,
      delayMs: 1000 * 2 ** n,
      errorMessage: OVERLOADED,
    });
  }
  events.push(...attempt().slice(0, -1));
  events.push({ type: 'agent_end', messages: [failed], willRetry: false });
  events.push({ type: 'auto_retry_end', success: false, attempt: 3, finalError: OVERLOADED });
  events.push({ type: 'agent_settled', aborted: false });
  return events;
}

const SONNET_USAGE_1 = {
  input: 4,
  output: 79,
  cacheRead: 1310,
  cacheWrite: 1207,
  totalTokens: 2600,
};
const SONNET_USAGE_2 = { input: 2, output: 14, cacheRead: 2517, cacheWrite: 98, totalTokens: 2631 };

/**
 * A `bash` call the gate answered, then the model's reply (`r2-1-gate/rpc-run1.jsonl:9-40` for a
 * refusal, `:44-73` for an approval).
 */
function bashTurn(id: string, approved: boolean): PiRpcEvent[] {
  const args = { command: 'echo r21 > denied.txt', timeout: null };
  const toolUse = assistant(
    'claude-sonnet-5-5',
    [{ type: 'toolCall', id, name: 'bash', arguments: args }],
    'toolUse',
    SONNET_USAGE_1
  );
  const replyText = approved ? 'DONE' : 'BLOCKED gate: not approved';
  const reply = assistant(
    'claude-sonnet-5-5',
    [{ type: 'text', text: replyText }],
    'stop',
    SONNET_USAGE_2
  );
  const result = approved
    ? {
        content: [{ type: 'text', text: '(no output)' }],
        structuredContent: { output: '', exit_code: 0 },
      }
    : { content: [{ type: 'text', text: 'gate: not approved' }], details: {} };
  return [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: user('Use the bash tool') },
    { type: 'message_end', message: user('Use the bash tool') },
    {
      type: 'message_start',
      message: { ...toolUse, content: [], stopReason: 'pending', usage: ZERO },
    },
    update({ type: 'toolcall_start', contentIndex: 0, id, toolName: 'bash' }),
    update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"command": "echo r21 >' }),
    update({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { type: 'toolCall', id, name: 'bash', arguments: args },
    }),
    { type: 'message_end', message: toolUse },
    { type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args },
    {
      type: 'extension_ui_request',
      id: 'ui-1',
      method: 'confirm',
      title: 'switch:n:run:1',
      message: '{}',
    },
    ...(approved
      ? [
          {
            type: 'tool_execution_update',
            toolCallId: id,
            toolName: 'bash',
            args,
            partialResult: { content: [] },
          },
        ]
      : []),
    { type: 'tool_execution_end', toolCallId: id, toolName: 'bash', result, isError: !approved },
    {
      type: 'message_start',
      message: { role: 'toolResult', toolCallId: id, toolName: 'bash', content: result.content },
    },
    {
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: id, toolName: 'bash', content: result.content },
    },
    { type: 'turn_end', message: toolUse },
    { type: 'turn_start' },
    {
      type: 'message_start',
      message: { ...reply, content: [], stopReason: 'pending', usage: ZERO },
    },
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: replyText }),
    update({ type: 'text_end', contentIndex: 0, content: replyText }),
    { type: 'message_end', message: reply },
    { type: 'turn_end', message: reply },
    { type: 'agent_end', messages: [toolUse, reply], willRetry: false },
    { type: 'agent_settled', aborted: false },
  ];
}

/** `abort` during an approved `bash` (`r2-3-abort/rpc-run1.jsonl:9-43`). */
function abortedTurn(id: string): PiRpcEvent[] {
  const args = { command: '(sleep 10; echo late > r23-bg.txt) & sleep 30', timeout: null };
  const toolUse = assistant(
    'claude-sonnet-5-5',
    [{ type: 'toolCall', id, name: 'bash', arguments: args }],
    'toolUse',
    SONNET_USAGE_1
  );
  const aborted = assistant('claude-sonnet-5-5', [], 'error', ZERO, {
    errorMessage: 'This operation was aborted',
  });
  return [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: { ...toolUse, content: [], stopReason: 'pending' } },
    { type: 'message_end', message: toolUse },
    { type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args },
    {
      type: 'tool_execution_update',
      toolCallId: id,
      toolName: 'bash',
      args,
      partialResult: { content: [] },
    },
    {
      type: 'tool_execution_end',
      toolCallId: id,
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'Command aborted' }], details: {} },
      isError: true,
      durationMs: 2002,
    },
    { type: 'turn_end', message: toolUse },
    { type: 'turn_start' },
    { type: 'message_start', message: aborted },
    { type: 'message_end', message: aborted },
    { type: 'turn_end', message: aborted },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'agent_settled', aborted: true },
  ];
}

function run(mapper: PiTurnMapper, events: PiRpcEvent[]): PiTurnEvent[] {
  return events.flatMap((event) => mapper.handle(event));
}
const completions = (events: PiTurnEvent[]) =>
  events.filter((event) => event.type === 'turn.completed');
const completedItems = (events: PiTurnEvent[]) =>
  events.flatMap((event) => (event.type === 'item.completed' ? [event.item] : []));

describe('one turn.completed, on agent_settled only', () => {
  it('a plain text turn streams the reply and ends with its usage', () => {
    const mapper = new PiTurnMapper({ turnId: 't1' });
    const events = run(mapper, fakePiTextTurn('hi', 'hello there'));
    expect(events.map((event) => event.type)).toEqual([
      'item.started',
      'content.delta',
      'item.completed',
      'turn.completed',
    ]);
    expect(events[1]).toMatchObject({ type: 'content.delta', turnId: 't1', delta: 'hello there' });
    expect(completedItems(events)).toEqual([
      {
        id: 't1:message:1:0',
        type: 'assistant_message',
        status: 'completed',
        title: 'hello there',
        text: 'hello there',
      },
    ]);
    expect(events.at(-1)).toEqual({
      type: 'turn.completed',
      turnId: 't1',
      outcome: 'completed',
      usage: [
        {
          model: 'fake-model',
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    });
    expect(mapper.completed).toBe(true);
  });

  it('agent_end → retry → agent_settled: nothing ends at agent_end, one completion at the end', () => {
    const mapper = new PiTurnMapper({ turnId: 't2' });
    const events = retryThenOk();
    const settled = events.findIndex((event) => event.type === 'agent_settled');
    const before = run(mapper, events.slice(0, settled));
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(2);
    expect(completions(before)).toEqual([]);
    expect(mapper.completed).toBe(false);
    expect(before.filter((event) => event.type === 'runtime.warning')).toEqual([
      {
        type: 'runtime.warning',
        turnId: 't2',
        message: `Pi is retrying the request (attempt 1 of 3): ${OVERLOADED}`,
      },
    ]);
    const after = run(mapper, events.slice(settled));
    expect(completions(after)).toEqual([
      {
        type: 'turn.completed',
        turnId: 't2',
        outcome: 'completed',
        usage: [
          {
            model: 'fake-model',
            inputTokens: 11,
            outputTokens: 7,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        ],
      },
    ]);
  });

  it('retries that run out end the turn once, in error, with what Pi gave up on', () => {
    const mapper = new PiTurnMapper({ turnId: 't3' });
    const events = retryExhausted();
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(4);
    const out = run(mapper, events);
    expect(completions(out)).toEqual([
      { type: 'turn.completed', turnId: 't3', outcome: 'error', message: OVERLOADED, usage: [] },
    ]);
  });

  it('nothing is mapped after the turn ends: a second agent_settled, a late tool, finish', () => {
    const mapper = new PiTurnMapper({ turnId: 't4' });
    run(mapper, fakePiTextTurn('a', 'b'));
    expect(mapper.handle({ type: 'agent_settled', aborted: false })).toEqual([]);
    expect(
      mapper.handle({
        type: 'tool_execution_start',
        toolCallId: 'late',
        toolName: 'bash',
        args: {},
      })
    ).toEqual([]);
    expect(mapper.finish('error', 'exit')).toEqual([]);
  });

  it('an end the adapter sees first (ER-02) is the only one', () => {
    const mapper = new PiTurnMapper({ turnId: 't5' });
    const events = retryThenOk();
    run(mapper, events.slice(0, 8));
    const ended = mapper.finish('error', 'Pi exited');
    expect(completions(ended)).toEqual([
      { type: 'turn.completed', turnId: 't5', outcome: 'error', message: 'Pi exited', usage: [] },
    ]);
    expect(run(mapper, events.slice(8))).toEqual([]);
  });

  it('abort ends the turn interrupted; the aborted call fails', () => {
    const mapper = new PiTurnMapper({ turnId: 't6' });
    const out = run(mapper, abortedTurn('toolu_ab'));
    expect(completedItems(out)).toMatchObject([
      { id: 'toolu_ab', type: 'command_execution', status: 'failed', text: 'Command aborted' },
    ]);
    expect(completions(out)).toEqual([
      {
        type: 'turn.completed',
        turnId: 't6',
        outcome: 'interrupted',
        usage: [
          {
            model: 'claude-sonnet-5-5',
            inputTokens: 4,
            outputTokens: 79,
            cacheReadTokens: 1310,
            cacheWriteTokens: 1207,
          },
        ],
      },
    ]);
  });

  it('a last message in error without retries ends the turn in error', () => {
    const mapper = new PiTurnMapper({ turnId: 't7' });
    const failed = assistant('m', [], 'error', ZERO, {
      errorMessage: 'No API key for provider: fake',
    });
    const out = run(mapper, [
      { type: 'agent_start' },
      { type: 'message_start', message: failed },
      { type: 'message_end', message: failed },
      { type: 'agent_end', messages: [failed], willRetry: false },
      { type: 'agent_settled', aborted: false },
    ]);
    expect(completions(out)).toEqual([
      {
        type: 'turn.completed',
        turnId: 't7',
        outcome: 'error',
        message: 'No API key for provider: fake',
        usage: [],
      },
    ]);
  });
});

describe('declined', () => {
  it('a call the adapter refused ends declined, with what the bridge said', () => {
    const mapper = new PiTurnMapper({ turnId: 'd1' });
    const events = bashTurn('toolu_deny', false);
    const ask = events.findIndex((event) => event.type === 'extension_ui_request');
    const out = run(mapper, events.slice(0, ask + 1));
    mapper.markDeclined('toolu_deny');
    out.push(...run(mapper, events.slice(ask + 1)));
    const items = completedItems(out);
    expect(items[0]).toEqual({
      id: 'toolu_deny',
      type: 'command_execution',
      status: 'declined',
      title: 'echo r21 > denied.txt',
      payload: { args: { command: 'echo r21 > denied.txt', timeout: null } },
      text: 'gate: not approved',
    });
    expect(items[1]).toMatchObject({
      type: 'assistant_message',
      text: 'BLOCKED gate: not approved',
    });
    expect(completions(out)).toHaveLength(1);
    expect(completions(out)[0]).toMatchObject({ outcome: 'completed' });
  });

  it('a failed call the adapter did not refuse is failed, not declined', () => {
    const mapper = new PiTurnMapper({ turnId: 'd2' });
    const items = completedItems(run(mapper, bashTurn('toolu_fail', false)));
    expect(items[0]).toMatchObject({ id: 'toolu_fail', status: 'failed' });
  });

  it('an approved call completes with its output; an empty partial result is no update', () => {
    const mapper = new PiTurnMapper({ turnId: 'd3' });
    const out = run(mapper, bashTurn('toolu_ok', true));
    expect(out.filter((event) => event.type === 'item.updated')).toEqual([]);
    expect(completedItems(out)[0]).toMatchObject({
      id: 'toolu_ok',
      status: 'completed',
      text: '(no output)',
    });
    expect(completions(out)[0]).toMatchObject({
      usage: [
        {
          model: 'claude-sonnet-5-5',
          inputTokens: 6,
          outputTokens: 93,
          cacheReadTokens: 3827,
          cacheWriteTokens: 1305,
        },
      ],
    });
  });

  it('a refused call still open when the turn is forced to end is declined; open text fails', () => {
    const mapper = new PiTurnMapper({ turnId: 'd4' });
    mapper.handle({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'write',
      args: { path: 'a.ts' },
    });
    mapper.handle({
      type: 'tool_execution_start',
      toolCallId: 'c2',
      toolName: 'bash',
      args: { command: 'ls' },
    });
    mapper.handle({ type: 'message_start', message: assistant('m', [], 'pending', ZERO) });
    mapper.handle(update({ type: 'text_start', contentIndex: 0 }));
    mapper.handle(update({ type: 'text_delta', contentIndex: 0, delta: 'par' }));
    mapper.markDeclined('c1');
    const out = mapper.finish('interrupted');
    expect(completedItems(out).map((item) => [item.id, item.status])).toEqual([
      ['d4:message:1:0', 'failed'],
      ['c1', 'declined'],
      ['c2', 'failed'],
    ]);
    expect(completions(out)).toEqual([
      { type: 'turn.completed', turnId: 'd4', outcome: 'interrupted', usage: [] },
    ]);
  });
});

describe('item types', () => {
  it.each([
    ['bash', 'command_execution'],
    ['edit', 'file_change'],
    ['write', 'file_change'],
    ['mcp__switch__post', 'mcp_tool_call'],
    ['mcp__team_docs__search', 'mcp_tool_call'],
    ['read_mcp_resource', 'mcp_tool_call'],
    ['list_mcp_resources', 'mcp_tool_call'],
    ['read', 'tool_call'],
    ['grep', 'tool_call'],
    ['todo', 'tool_call'],
  ] as const)('%s → %s', (toolName, type) => {
    expect(piItemType(toolName)).toBe(type);
    const mapper = new PiTurnMapper({ turnId: 'i' });
    const [started] = mapper.handle({
      type: 'tool_execution_start',
      toolCallId: 'x',
      toolName,
      args: { path: 'src/a.ts' },
    });
    expect(started).toMatchObject({
      type: 'item.started',
      item: { id: 'x', type, status: 'in_progress' },
    });
  });

  it('titles: the command, the path, the tool; tool-shaped items carry the tool name', () => {
    const mapper = new PiTurnMapper({ turnId: 'i2' });
    const title = (toolName: string, args: object) => {
      const [event] = mapper.handle({
        type: 'tool_execution_start',
        toolCallId: toolName,
        toolName,
        args,
      });
      return event?.type === 'item.started' ? event.item : undefined;
    };
    expect(title('bash', { command: '\nnpm test\nnpm run lint' })).toMatchObject({
      title: 'npm test',
    });
    expect(title('edit', { path: 'src/a.ts' })).toMatchObject({ title: 'src/a.ts' });
    expect(title('edit', { path: 'src/a.ts' })).toBeUndefined();
    expect(title('mcp__switch__post', { text: 'x' })).toMatchObject({
      title: 'mcp__switch__post',
      toolName: 'mcp__switch__post',
    });
    expect(title('bash', {})).toBeUndefined();
  });

  it('a running tool is updated with what it has so far', () => {
    const mapper = new PiTurnMapper({ turnId: 'i3' });
    mapper.handle({
      type: 'tool_execution_start',
      toolCallId: 'b',
      toolName: 'bash',
      args: { command: 'yes' },
    });
    const partial = (text: string) =>
      mapper.handle({
        type: 'tool_execution_update',
        toolCallId: 'b',
        partialResult: { content: [{ type: 'text', text }] },
      });
    expect(partial('y')).toMatchObject([
      { type: 'item.updated', item: { id: 'b', text: 'y', status: 'in_progress' } },
    ]);
    expect(partial('y')).toEqual([]);
    expect(partial('y\ny')).toMatchObject([{ type: 'item.updated', item: { text: 'y\ny' } }]);
  });

  it('a tool that ends without a start still gets both events', () => {
    const mapper = new PiTurnMapper({ turnId: 'i4' });
    const out = mapper.handle({
      type: 'tool_execution_end',
      toolCallId: 'z',
      toolName: 'write',
      result: { content: [{ type: 'text', text: 'Successfully wrote to a.ts' }] },
      isError: false,
    });
    expect(out.map((event) => event.type)).toEqual(['item.started', 'item.completed']);
    expect(completedItems(out)[0]).toMatchObject({ type: 'file_change', status: 'completed' });
  });

  it('thinking is reasoning, streamed as item deltas', () => {
    const mapper = new PiTurnMapper({ turnId: 'r' });
    const out = run(mapper, [
      { type: 'message_start', message: assistant('m', [], 'pending', ZERO) },
      update({ type: 'thinking_start', contentIndex: 0 }),
      update({ type: 'thinking_delta', contentIndex: 0, delta: 'hmm' }),
      update({ type: 'thinking_end', contentIndex: 0, content: 'hmm.' }),
    ]);
    expect(out).toEqual([
      {
        type: 'item.started',
        turnId: 'r',
        item: { id: 'r:message:1:0', type: 'reasoning', status: 'in_progress', title: 'Reasoning' },
      },
      { type: 'item.delta', turnId: 'r', itemId: 'r:message:1:0', delta: 'hmm' },
      {
        type: 'item.completed',
        turnId: 'r',
        item: {
          id: 'r:message:1:0',
          type: 'reasoning',
          status: 'completed',
          title: 'hmm.',
          text: 'hmm.',
        },
      },
    ]);
  });

  it('a reply that was not streamed is an item at message_end', () => {
    const mapper = new PiTurnMapper({ turnId: 'n' });
    const reply = assistant('m', [{ type: 'text', text: 'whole' }], 'stop', ZERO);
    const out = run(mapper, [
      { type: 'message_start', message: { ...reply, content: [] } },
      { type: 'message_end', message: reply },
    ]);
    expect(out.map((event) => event.type)).toEqual(['item.started', 'item.completed']);
    expect(completedItems(out)[0]).toMatchObject({ type: 'assistant_message', text: 'whole' });
  });

  it('compaction during the run is an item and its usage counts', () => {
    const mapper = new PiTurnMapper({ turnId: 'c' });
    const reply = assistant('fake-model', [{ type: 'text', text: 'x' }], 'stop', {
      input: 30000,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
    });
    const out = run(mapper, [
      { type: 'message_start', message: reply },
      { type: 'message_end', message: reply },
      { type: 'compaction_start', reason: 'threshold' },
      {
        type: 'compaction_end',
        reason: 'threshold',
        result: {
          summary: 'SUMMARY',
          usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0 },
        },
        aborted: false,
        willRetry: false,
      },
      { type: 'agent_settled', aborted: false },
    ]);
    expect(completedItems(out).at(-1)).toMatchObject({
      id: 'c:compaction:1',
      type: 'context_compaction',
      status: 'completed',
      payload: { reason: 'threshold' },
    });
    expect(completions(out)[0]).toMatchObject({
      usage: [
        {
          model: 'fake-model',
          inputTokens: 30011,
          outputTokens: 14,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    });
  });
});

const TOO_LONG =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}';
const TRUNCATED_FAILED = 'Truncated response recovery failed after one compact-and-retry attempt.';
const OVERFLOW_FAILED =
  'Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.';

/**
 * Overflow → compaction → retry (`r2-4-retry/rpc-run2.full.jsonl:139-161`). With `secondTry`
 * the retried response is given instead of the recorded `stop`, and what follows it is Pi's own
 * (`core/agent-session.js:2391-2473`, `:2521-2649`).
 */
function overflowRecovery(secondTry: PiRpcEvent[] = []): PiRpcEvent[] {
  const tooLong = assistant('fake-model', [], 'error', ZERO, { errorMessage: TOO_LONG });
  const ok = assistant('fake-model', [{ type: 'text', text: 'ok' }], 'stop', {
    input: 11,
    output: 7,
    cacheRead: 0,
    cacheWrite: 0,
  });
  return [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: user('fill') },
    { type: 'message_end', message: user('fill') },
    { type: 'message_start', message: tooLong },
    { type: 'message_end', message: tooLong },
    { type: 'turn_end', message: tooLong },
    { type: 'agent_end', messages: [tooLong], willRetry: false },
    { type: 'entry_appended', entry: { type: 'context_edit' } },
    { type: 'compaction_start', reason: 'overflow' },
    {
      type: 'compaction_end',
      reason: 'overflow',
      result: {
        summary: 'SUMMARY-OVERFLOW',
        usage: { input: 22, output: 14, cacheRead: 0, cacheWrite: 0 },
      },
      aborted: false,
      willRetry: true,
    },
    { type: 'agent_start' },
    { type: 'turn_start' },
    ...(secondTry.length > 0
      ? secondTry
      : ([
          { type: 'message_start', message: { ...ok, content: [], stopReason: 'pending' } },
          { type: 'message_end', message: ok },
          { type: 'turn_end', message: ok },
          { type: 'agent_end', messages: [ok], willRetry: false },
        ] as PiRpcEvent[])),
    { type: 'agent_settled', aborted: false },
  ];
}

/** The retried response, and Pi giving up on it (`core/agent-session.js:2445-2464`). */
function failedAgain(stopReason: 'length' | 'error', errorMessage: string): PiRpcEvent[] {
  const again = assistant(
    'fake-model',
    stopReason === 'length' ? [{ type: 'text', text: 'cut' }] : [],
    stopReason,
    { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 },
    stopReason === 'error' ? { errorMessage: TOO_LONG } : {}
  );
  return [
    { type: 'message_start', message: { ...again, content: [], stopReason: 'pending' } },
    { type: 'message_end', message: again },
    { type: 'turn_end', message: again },
    { type: 'agent_end', messages: [again], willRetry: false },
    {
      type: 'compaction_end',
      reason: 'overflow',
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage,
    },
  ];
}

describe('compaction and the end of the turn', () => {
  it('a recovered overflow (recorded) completes; the compaction is an item', () => {
    const mapper = new PiTurnMapper({ turnId: 'o1', model: 'fake-model' });
    const out = run(mapper, overflowRecovery());
    expect(completedItems(out).find((item) => item.type === 'context_compaction')).toMatchObject({
      status: 'completed',
      payload: { reason: 'overflow' },
    });
    expect(completions(out)).toEqual([
      {
        type: 'turn.completed',
        turnId: 'o1',
        outcome: 'completed',
        usage: [
          {
            model: 'fake-model',
            inputTokens: 33,
            outputTokens: 21,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        ],
      },
    ]);
  });

  it.each([
    ['a truncated response', 'length', TRUNCATED_FAILED],
    ['a context overflow', 'error', OVERFLOW_FAILED],
  ] as const)(
    'Pi giving up recovering %s ends the turn in error with its message',
    (_name, stop, message) => {
      const mapper = new PiTurnMapper({ turnId: 'o2', model: 'fake-model' });
      const events = overflowRecovery(failedAgain(stop, message));
      const settled = events.findIndex((event) => event.type === 'agent_settled');
      const before = run(mapper, events.slice(0, settled));
      expect(completions(before)).toEqual([]);
      const out = run(mapper, events.slice(settled));
      expect(completions(out)).toEqual([
        {
          type: 'turn.completed',
          turnId: 'o2',
          outcome: 'error',
          message,
          usage: [
            {
              model: 'fake-model',
              inputTokens: 27,
              outputTokens: 17,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          ],
        },
      ]);
      expect(mapper.finish('error', 'late')).toEqual([]);
    }
  );

  it('a recovering compaction that fails ends the turn in error; its item fails', () => {
    const mapper = new PiTurnMapper({ turnId: 'o3' });
    const cut = assistant('m', [{ type: 'text', text: 'cut' }], 'length', ZERO);
    const out = run(mapper, [
      { type: 'message_start', message: cut },
      { type: 'message_end', message: cut },
      { type: 'agent_end', messages: [cut], willRetry: false },
      { type: 'compaction_start', reason: 'overflow' },
      {
        type: 'compaction_end',
        reason: 'overflow',
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage: 'Context overflow recovery failed: summary request failed',
      },
      { type: 'agent_settled', aborted: false },
    ]);
    expect(completedItems(out).at(-1)).toMatchObject({
      type: 'context_compaction',
      status: 'failed',
      text: 'Context overflow recovery failed: summary request failed',
    });
    expect(completions(out)[0]).toMatchObject({
      outcome: 'error',
      message: 'Context overflow recovery failed: summary request failed',
    });
  });

  it.each([
    ['threshold', 'Auto-compaction failed: summary request failed'],
    ['overflow', 'Context overflow recovery failed: summary request failed'],
  ])(
    'a %s compaction that fails after a response that stopped fails its item only',
    (reason, errorMessage) => {
      // `core/agent-session.js:2440-2443` (overflow after `stop`), `:2474-2507` (threshold).
      const mapper = new PiTurnMapper({ turnId: 'o4' });
      const reply = assistant('m', [{ type: 'text', text: 'answer' }], 'stop', ZERO);
      const out = run(mapper, [
        { type: 'message_start', message: reply },
        { type: 'message_end', message: reply },
        { type: 'agent_end', messages: [reply], willRetry: false },
        { type: 'compaction_start', reason },
        {
          type: 'compaction_end',
          reason,
          result: undefined,
          aborted: false,
          willRetry: false,
          errorMessage,
        },
        { type: 'agent_settled', aborted: false },
      ]);
      expect(completedItems(out).at(-1)).toMatchObject({
        type: 'context_compaction',
        status: 'failed',
        text: errorMessage,
      });
      expect(completions(out)[0]).toMatchObject({ outcome: 'completed' });
      expect(completions(out)[0]).not.toHaveProperty('message');
    }
  );

  it('a threshold compaction that fails after a cut response Pi cannot recover fails its item only', () => {
    // A `length` stop that is not recoverable goes to the threshold check (`:2437`, `:2474-2507`).
    const mapper = new PiTurnMapper({ turnId: 'o4b' });
    const cut = assistant('m', [{ type: 'text', text: 'cut' }], 'length', ZERO);
    const out = run(mapper, [
      { type: 'message_end', message: cut },
      { type: 'compaction_start', reason: 'threshold' },
      {
        type: 'compaction_end',
        reason: 'threshold',
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage: 'Auto-compaction failed: summary request failed',
      },
      { type: 'agent_settled', aborted: false },
    ]);
    expect(completedItems(out).at(-1)).toMatchObject({ status: 'failed' });
    expect(completions(out)[0]).toMatchObject({ outcome: 'completed' });
  });

  it('giving up before the run (on the last turn’s response) does not fail this turn', () => {
    // `_prepareRun` checks the previous turn's last response first (`agent-session.js:1480-1488`).
    const gaveUp: PiRpcEvent = {
      type: 'compaction_end',
      reason: 'overflow',
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: TRUNCATED_FAILED,
    };
    const mapper = new PiTurnMapper({ turnId: 'o5', model: 'fake-model' });
    const out = run(mapper, [gaveUp, ...fakePiTextTurn('next', 'fine')]);
    expect(completions(out)[0]).toMatchObject({ outcome: 'completed' });
    // Also when the run then writes no response at all.
    const empty = new PiTurnMapper({ turnId: 'o5b' });
    const settled = run(empty, [gaveUp, { type: 'agent_settled', aborted: false }]);
    expect(completions(settled)[0]).toMatchObject({ outcome: 'completed' });
  });

  it('a later response of the turn clears a recovery that failed', () => {
    const mapper = new PiTurnMapper({ turnId: 'o6' });
    const events = overflowRecovery(failedAgain('length', TRUNCATED_FAILED));
    const settled = events.findIndex((event) => event.type === 'agent_settled');
    run(mapper, events.slice(0, settled));
    const ok = assistant('m', [{ type: 'text', text: 'ok' }], 'stop', ZERO);
    const out = run(mapper, [
      { type: 'message_end', message: ok },
      { type: 'agent_settled', aborted: false },
    ]);
    expect(completions(out)[0]).toMatchObject({ outcome: 'completed' });
  });

  it('an aborted recovery is the abort, not an error', () => {
    const mapper = new PiTurnMapper({ turnId: 'o7' });
    const cut = assistant('m', [{ type: 'text', text: 'cut' }], 'length', ZERO);
    const out = run(mapper, [
      { type: 'message_end', message: cut },
      { type: 'compaction_start', reason: 'overflow' },
      {
        type: 'compaction_end',
        reason: 'overflow',
        result: undefined,
        aborted: true,
        willRetry: false,
      },
      { type: 'agent_settled', aborted: true },
    ]);
    expect(completions(out)[0]).toMatchObject({ outcome: 'interrupted' });
    // An aborted compaction is never a failed recovery, whatever it carries.
    const other = new PiTurnMapper({ turnId: 'o7b' });
    const settled = run(other, [
      { type: 'message_end', message: cut },
      {
        type: 'compaction_end',
        reason: 'overflow',
        result: undefined,
        aborted: true,
        willRetry: false,
        errorMessage: 'Compaction cancelled',
      },
      { type: 'agent_settled', aborted: false },
    ]);
    expect(completions(settled)[0]).toMatchObject({ outcome: 'completed' });
  });

  it('a compaction before the run counts under the session model (recorded)', () => {
    // `r2-4-retry/rpc-run2.full.jsonl:102` (`set_model` → `fake-small`), `:104-119`: Pi
    // compacts before the run (`agent-session.js:1480-1488`) with its model (`:2522`).
    const reply = assistant('fake-small', [{ type: 'text', text: 'ok after threshold' }], 'stop', {
      input: 11,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 18,
    });
    const events: PiRpcEvent[] = [
      { type: 'compaction_start', reason: 'threshold' },
      {
        type: 'compaction_end',
        reason: 'threshold',
        result: {
          summary: 'SUMMARY-THRESHOLD',
          tokensBefore: 30007,
          usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18 },
        },
        aborted: false,
        willRetry: false,
      },
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'message_start', message: user('after threshold') },
      { type: 'message_end', message: user('after threshold') },
      {
        type: 'message_start',
        message: {
          ...reply,
          content: [{ type: 'text', text: '', index: 0 }],
          stopReason: 'pending',
        },
      },
      update({ type: 'text_start', contentIndex: 0 }),
      update({ type: 'text_delta', contentIndex: 0, delta: 'ok after threshold' }),
      update({ type: 'text_end', contentIndex: 0, content: 'ok after threshold' }),
      { type: 'message_end', message: reply },
      { type: 'turn_end', message: reply },
      { type: 'agent_end', messages: [reply], willRetry: false },
      { type: 'agent_settled', aborted: false },
    ];
    const mapper = new PiTurnMapper({ turnId: 'm1', model: 'fake-small' });
    const out = run(mapper, events);
    expect(completedItems(out)[0]).toMatchObject({
      id: 'm1:compaction:1',
      type: 'context_compaction',
      status: 'completed',
    });
    expect(completions(out)[0]).toMatchObject({
      outcome: 'completed',
      usage: [
        {
          model: 'fake-small',
          inputTokens: 22,
          outputTokens: 14,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    });
  });
});

describe('usage', () => {
  it('one entry per model, zero reports dropped, nothing reported → []', () => {
    const mapper = new PiTurnMapper({ turnId: 'u' });
    const a = assistant('model-a', [], 'toolUse', {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    });
    const b = assistant('model-b', [], 'stop', {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
    });
    const z = assistant('model-z', [], 'stop', ZERO);
    const out = run(mapper, [
      { type: 'message_end', message: a },
      { type: 'message_end', message: z },
      { type: 'message_end', message: b },
      { type: 'message_end', message: a },
      { type: 'agent_settled', aborted: false },
    ]);
    expect(completions(out)[0]).toMatchObject({
      usage: [
        {
          model: 'model-a',
          inputTokens: 2,
          outputTokens: 4,
          cacheReadTokens: 6,
          cacheWriteTokens: 8,
        },
        {
          model: 'model-b',
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
    });
    const empty = new PiTurnMapper({ turnId: 'u2' });
    expect(completions(run(empty, [{ type: 'agent_settled', aborted: false }]))[0]).toMatchObject({
      usage: [],
    });
  });
});
