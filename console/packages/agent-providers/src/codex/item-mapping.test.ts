import { describe, expect, it } from 'vitest';
import { mapCodexItem } from './item-mapping';
import type { CodexThreadItem } from './protocol';

describe('mapCodexItem', () => {
  it('maps a command execution with its own status and output', () => {
    const item = mapCodexItem(
      {
        type: 'commandExecution',
        id: 'exec-1',
        command: '/bin/zsh -lc "echo hi"',
        cwd: '/w',
        status: 'declined',
        aggregatedOutput: 'hi\n',
        exitCode: null,
      },
      'completed'
    );
    expect(item).toMatchObject({
      type: 'command_execution',
      status: 'declined',
      title: '/bin/zsh -lc "echo hi"',
      text: 'hi\n',
    });
  });

  it('names a file change after the paths it touches', () => {
    const item = mapCodexItem(
      {
        type: 'fileChange',
        id: 'patch-1',
        status: 'completed',
        changes: [{ path: 'a.txt', kind: 'add', diff: '+a' }],
      },
      'completed'
    );
    expect(item).toMatchObject({ type: 'file_change', title: 'a.txt', status: 'completed' });
  });

  it('maps both collab shapes onto subagent', () => {
    const collab = mapCodexItem(
      {
        type: 'collabAgentToolCall',
        id: 'call-1',
        tool: 'spawnAgent',
        status: 'inProgress',
        senderThreadId: 'parent',
        receiverThreadIds: ['child'],
        prompt: 'read the readme',
      },
      'started'
    );
    expect(collab).toMatchObject({ type: 'subagent', status: 'in_progress', title: 'spawnAgent' });

    const activity = mapCodexItem(
      {
        type: 'subAgentActivity',
        id: 'act-1',
        kind: 'started',
        agentThreadId: 'child',
        agentPath: '/root/read_readme',
      },
      'completed'
    );
    expect(activity).toMatchObject({
      type: 'subagent',
      status: 'completed',
      title: '/root/read_readme',
    });
  });

  it('takes status from the lifecycle for items that carry none', () => {
    const started = mapCodexItem(
      { type: 'agentMessage', id: 'msg-1', text: 'hello\nworld', phase: 'final_answer' },
      'started'
    );
    expect(started).toMatchObject({
      type: 'assistant_message',
      status: 'in_progress',
      title: 'hello',
      text: 'hello\nworld',
    });
  });

  it('falls back to tool_call for an item type it does not know', () => {
    const unknown = { type: 'imageGeneration', id: 'img-1' } as unknown as CodexThreadItem;
    expect(mapCodexItem(unknown, 'started')).toMatchObject({
      type: 'tool_call',
      id: 'img-1',
      title: 'imageGeneration',
    });
  });

  it('maps an mcp tool call to its qualified name', () => {
    expect(
      mapCodexItem(
        {
          type: 'mcpToolCall',
          id: 'mcp-1',
          server: 'switch',
          tool: 'post_message',
          status: 'completed',
          error: null,
        },
        'completed'
      )
    ).toMatchObject({
      type: 'mcp_tool_call',
      title: 'switch.post_message',
      toolName: 'post_message',
    });
  });
});
