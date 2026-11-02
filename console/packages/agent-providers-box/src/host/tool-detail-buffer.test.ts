import { expect, it } from 'vitest';
import type { ProviderItem, ProviderRuntimeEvent } from '../events';
import {
  TOOL_ANSWER_LIMIT,
  TOOL_DETAIL_TURN_LIMIT,
  TOOL_INPUT_STRING_LIMIT,
  TOOL_OUTPUT_HEAD,
  TOOL_OUTPUT_TAIL,
  ToolDetailBuffer,
} from './tool-detail-buffer';

const base = { eventId: 'e', provider: 'claude', sessionId: 'session', createdAt: '' } as const;

function itemEvent(
  type: 'item.started' | 'item.updated' | 'item.completed',
  turnId: string,
  item: Partial<ProviderItem> & { id: string }
): ProviderRuntimeEvent {
  return {
    ...base,
    type,
    turnId,
    item: { type: 'tool_call', status: 'in_progress', title: '', ...item },
  };
}

it('keeps a Claude call’s input from its start and its output from its result', () => {
  const buffer = new ToolDetailBuffer();
  buffer.ingest(
    itemEvent('item.started', 'turn', {
      id: 'tu1',
      type: 'command_execution',
      toolName: 'Bash',
      title: 'ls -la',
      payload: { command: 'ls -la' },
    }),
    'epoch'
  );
  buffer.ingest(
    itemEvent('item.completed', 'turn', {
      id: 'tu1',
      type: 'command_execution',
      status: 'completed',
      toolName: 'Bash',
      title: 'ls -la',
      payload: { command: 'ls -la' },
      text: 'total 0',
    }),
    'epoch'
  );
  expect(buffer.list('epoch', ['turn'])).toEqual([
    {
      turnId: 'turn',
      tools: [
        {
          itemId: JSON.stringify(['turn', 'tu1']),
          type: 'command_execution',
          toolName: 'Bash',
          input: { command: 'ls -la' },
          output: 'total 0',
          truncated: false,
          exitCode: null,
        },
      ],
    },
  ]);
});

it('streams a command’s output from deltas and takes its exit code (Codex)', () => {
  const buffer = new ToolDetailBuffer();
  const payload = { command: 'make', cwd: '/w', exitCode: null };
  buffer.ingest(
    itemEvent('item.started', 't', { id: 'c', type: 'command_execution', payload }),
    'epoch'
  );
  buffer.ingest(
    { ...base, type: 'item.delta', turnId: 't', itemId: 'c', delta: 'built\n' },
    'epoch'
  );
  expect(buffer.list('epoch', null)[0]!.tools[0]!.output).toBe('built\n');
  buffer.ingest(
    itemEvent('item.completed', 't', {
      id: 'c',
      type: 'command_execution',
      status: 'failed',
      payload: { ...payload, exitCode: 2 },
      text: 'built\nerror\n',
    }),
    'epoch'
  );
  const [tool] = buffer.list('epoch', null)[0]!.tools;
  expect(tool).toMatchObject({ output: 'built\nerror\n', exitCode: 2 });
});

it('unwraps OpenCode’s nested input and ignores reasoning and messages', () => {
  const buffer = new ToolDetailBuffer();
  buffer.ingest(
    itemEvent('item.started', 't', {
      id: 'p',
      toolName: 'read',
      payload: { tool: 'read', input: { filePath: '/a.ts' }, status: 'running' },
    }),
    'epoch'
  );
  buffer.ingest(itemEvent('item.started', 't', { id: 'r', type: 'reasoning' }), 'epoch');
  buffer.ingest(itemEvent('item.started', 't', { id: 'm', type: 'assistant_message' }), 'epoch');
  const tools = buffer.list('epoch', null)[0]!.tools;
  expect(tools.map((tool) => tool.input)).toEqual([{ filePath: '/a.ts' }]);
});

it('clips long input strings and long output, keeping the output’s head and tail', () => {
  const buffer = new ToolDetailBuffer();
  const content = 'x'.repeat(TOOL_INPUT_STRING_LIMIT + 50);
  const output = `${'h'.repeat(TOOL_OUTPUT_HEAD)}${'m'.repeat(5000)}${'t'.repeat(TOOL_OUTPUT_TAIL)}`;
  buffer.ingest(
    itemEvent('item.completed', 't', {
      id: 'w',
      type: 'file_change',
      payload: { file_path: '/f', content },
      text: output,
    }),
    'epoch'
  );
  const [tool] = buffer.list('epoch', null)[0]!.tools;
  expect(tool!.truncated).toBe(true);
  expect((tool!.input as { content: string }).content).toHaveLength(TOOL_INPUT_STRING_LIMIT + 1);
  expect(tool!.output).toBe(`${'h'.repeat(TOOL_OUTPUT_HEAD)}\n…\n${'t'.repeat(TOOL_OUTPUT_TAIL)}`);
});

it('drops everything on a new epoch and the oldest turns past its limit', () => {
  const buffer = new ToolDetailBuffer();
  for (let index = 0; index <= TOOL_DETAIL_TURN_LIMIT; index += 1)
    buffer.ingest(itemEvent('item.started', `turn-${index}`, { id: 'x' }), 'epoch');
  const turns = buffer.list('epoch', null);
  expect(turns).toHaveLength(TOOL_DETAIL_TURN_LIMIT);
  expect(turns[0]!.turnId).toBe('turn-1');
  expect(buffer.list('other', null)).toEqual([]);
  buffer.ingest(itemEvent('item.started', 'fresh', { id: 'x' }), 'next');
  expect(buffer.list('next', null).map((turn) => turn.turnId)).toEqual(['fresh']);
});

it('keeps an answer bounded, newest turns first, listing what is left over bare', () => {
  const buffer = new ToolDetailBuffer();
  const big = 'o'.repeat(TOOL_OUTPUT_HEAD + TOOL_OUTPUT_TAIL);
  for (let turn = 0; turn < 3; turn += 1)
    for (let call = 0; call < 60; call += 1)
      buffer.ingest(
        itemEvent('item.completed', `turn-${turn}`, { id: `c${call}`, payload: {}, text: big }),
        'epoch'
      );
  const turns = buffer.list('epoch', null);
  const size = JSON.stringify(turns).length;
  expect(size).toBeLessThan(TOOL_ANSWER_LIMIT * 1.1);
  expect(turns.at(-1)!.turnId).toBe('turn-2');
  expect(turns.at(-1)!.tools[0]!.output).toBe(big);
  expect(turns.flatMap((turn) => turn.tools).some((tool) => tool.output === null)).toBe(true);
});
