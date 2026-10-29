import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { historyFromClaudeMessages } from './claude-history';

function entry(
  type: SessionMessage['type'],
  uuid: string,
  content: unknown,
  parentToolUseId: string | null = null
): SessionMessage {
  return {
    type,
    uuid,
    session_id: 'conversation',
    message: { role: type, content },
    parent_tool_use_id: parentToolUseId,
    parent_agent_id: null,
  };
}

it('turns a Claude Code transcript into turns that start at each prompt someone typed', () => {
  const turns = historyFromClaudeMessages([
    entry('user', 'u1', 'Why does the build fail?'),
    entry('assistant', 'a1', [
      { type: 'thinking', thinking: 'Let me look.' },
      { type: 'text', text: 'Checking the build.' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pnpm build' } },
    ]),
    entry('user', 'r1', [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true }]),
    entry('assistant', 'a2', [{ type: 'text', text: 'A type error in main.ts.' }]),
    entry('user', 'u2', [
      { type: 'text', text: '<ide_opened_file>main.ts</ide_opened_file>' },
      { type: 'text', text: 'Fix it' },
      { type: 'image', source: {} },
    ]),
    entry('assistant', 'a3', [
      { type: 'tool_use', id: 'tool-2', name: 'Edit', input: { file_path: 'main.ts' } },
    ]),
    entry('user', 'r2', [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'ok' }]),
  ]);

  expect(turns).toEqual([
    {
      turnId: 'u1',
      items: [
        {
          itemId: 'u1',
          kind: 'user-message',
          status: 'completed',
          title: '',
          text: 'Why does the build fail?',
        },
        {
          itemId: 'a1:1',
          kind: 'assistant-message',
          status: 'completed',
          title: '',
          text: 'Checking the build.',
        },
        {
          itemId: 'a1:2',
          kind: 'tool-activity',
          status: 'failed',
          title: 'pnpm build',
          text: '',
        },
        {
          itemId: 'a2:0',
          kind: 'assistant-message',
          status: 'completed',
          title: '',
          text: 'A type error in main.ts.',
        },
      ],
    },
    {
      turnId: 'u2',
      items: [
        {
          itemId: 'u2',
          kind: 'user-message',
          status: 'completed',
          title: '',
          text: 'Fix it\n\n[image]',
        },
        {
          itemId: 'a3:0',
          kind: 'tool-activity',
          status: 'completed',
          title: 'Edit main.ts',
          text: '',
        },
      ],
    },
  ]);
});

it('shows a slash command as typed and leaves out what Claude Code added on its own', () => {
  const turns = historyFromClaudeMessages([
    entry(
      'user',
      'c1',
      '<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>main.ts</command-args>'
    ),
    entry('user', 'c2', '<local-command-stdout>Reviewed.</local-command-stdout>'),
    entry('user', 'n1', '<task-notification>\nThe build finished.\n</task-notification>'),
  ]);

  expect(turns.map((turn) => turn.items.map((item) => item.text))).toEqual([['/review main.ts']]);
});

it('leaves out a stopped turn’s note and command output, and shows a ! command as typed', () => {
  const turns = historyFromClaudeMessages([
    entry('user', 'u1', 'Run the tests'),
    entry('user', 'i1', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
    entry(
      'user',
      'c1',
      '<command-message>review</command-message>\n<command-name>/review</command-name>'
    ),
    entry('user', 'b1', '<bash-input>git status</bash-input>'),
    entry('user', 'b2', '<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>'),
    entry('user', 'p1', '<div> is not centred, why?'),
    entry('user', 'p2', '<config><key>v</key></config>'),
  ]);

  expect(turns.map((turn) => turn.items.map((item) => item.text))).toEqual([
    ['Run the tests'],
    ['/review'],
    ['! git status'],
    ['<div> is not centred, why?'],
    ['<config><key>v</key></config>'],
  ]);
});

it('marks where a conversation was compacted instead of showing its summary as a prompt', () => {
  const turns = historyFromClaudeMessages([
    entry(
      'user',
      's1',
      'This session is being continued from a previous conversation that ran out of context. The conversation is summarized below: …'
    ),
    entry('user', 'u1', 'Carry on'),
  ]);

  expect(
    turns.map((turn) => turn.items.map((item) => [item.kind, item.title || item.text]))
  ).toEqual([
    [['tool-activity', 'Conversation compacted: the turns before this were summarized']],
    [['user-message', 'Carry on']],
  ]);
});

it('leaves out what a subagent said, which its own tool call stands for', () => {
  const turns = historyFromClaudeMessages([
    entry('user', 'u1', 'Explore the repo'),
    entry('assistant', 'a1', [
      { type: 'tool_use', id: 'task-1', name: 'Agent', input: { description: 'Survey the code' } },
    ]),
    entry('user', 's1', 'Survey the code', 'task-1'),
    entry('assistant', 's2', [{ type: 'text', text: 'Found three packages.' }], 'task-1'),
  ]);

  expect(turns).toHaveLength(1);
  expect(turns[0]!.items.map((item) => item.title || item.text)).toEqual([
    'Explore the repo',
    'Survey the code',
  ]);
});
