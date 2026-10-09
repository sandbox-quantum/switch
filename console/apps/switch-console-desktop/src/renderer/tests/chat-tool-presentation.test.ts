import type { Item } from '@switch-console/shared/session-v1';
import { describe, expect, it } from 'vitest';
import { presentTool, shortPath, summarizeTools } from '@renderer/features/chats/tool-presentation';
import type { ToolDetail } from '@shared/core/sessions/reasoning';

function item(title: string, status: Item['status'] = 'completed'): Item {
  return {
    itemId: '["turn","t1"]',
    turnId: 'turn',
    revision: 1,
    kind: 'tool-activity',
    status,
    title,
    text: '',
    attachments: [],
    origin: null,
  };
}

function detail(extra: Partial<ToolDetail>): ToolDetail {
  return {
    itemId: '["turn","t1"]',
    type: 'tool_call',
    toolName: null,
    input: null,
    output: null,
    truncated: false,
    exitCode: null,
    ...extra,
  };
}

describe('presentTool', () => {
  it('shows a command with its output and a failing exit code', () => {
    const shown = presentTool(
      item('ls -la'),
      detail({
        type: 'command_execution',
        toolName: 'Bash',
        input: { command: 'ls -la' },
        output: 'total 0',
        exitCode: 2,
      })
    );
    expect(shown).toMatchObject({ kind: 'shell', verb: 'Ran', subject: 'ls -la', code: true });
    expect(shown.details).toEqual({
      kind: 'command',
      command: 'ls -la',
      output: 'total 0',
      exitCode: 2,
    });
    expect(presentTool(item('ls -la', 'in-progress'), detail({ toolName: 'Bash' })).verb).toBe(
      'Running'
    );
  });

  it('names the file a read opened and shows what it read', () => {
    const shown = presentTool(
      item('Read'),
      detail({ toolName: 'Read', input: { file_path: '/repo/src/store.ts' }, output: '1\tx' })
    );
    expect(shown).toMatchObject({ kind: 'read', verb: 'Read', subject: '/repo/src/store.ts' });
    expect(shown.details).toEqual({ kind: 'read', path: '/repo/src/store.ts', output: '1\tx' });
  });

  it('shows an edit as a diff of what it replaced, and a write as all added', () => {
    const edit = presentTool(
      item('Edit /a.ts'),
      detail({
        type: 'file_change',
        toolName: 'Edit',
        input: { file_path: '/a.ts', old_string: 'one', new_string: 'two\nthree' },
      })
    );
    expect(edit).toMatchObject({ kind: 'edit', verb: 'Edited', subject: '/a.ts' });
    expect(edit.details).toEqual({
      kind: 'diff',
      path: '/a.ts',
      lines: [
        { sign: '-', text: 'one' },
        { sign: '+', text: 'two' },
        { sign: '+', text: 'three' },
      ],
    });
    const write = presentTool(
      item('Write /b.ts'),
      detail({
        type: 'file_change',
        toolName: 'Write',
        input: { file_path: '/b.ts', content: 'x' },
      })
    );
    expect(write.verb).toBe('Wrote');
    expect(write.details).toMatchObject({ lines: [{ sign: '+', text: 'x' }] });
  });

  it('reads a Codex file change from its unified diff', () => {
    const shown = presentTool(
      item('src/a.ts'),
      detail({ type: 'file_change', input: { changes: [] }, output: '--- a\n+++ b\n-old\n+new' })
    );
    expect(shown.subject).toBe('src/a.ts');
    expect(shown.details).toMatchObject({
      lines: [
        { sign: ' ', text: '--- a' },
        { sign: ' ', text: '+++ b' },
        { sign: '-', text: 'old' },
        { sign: '+', text: 'new' },
      ],
    });
  });

  it('shows what a search looked for and what it found', () => {
    const shown = presentTool(
      item('Grep'),
      detail({ toolName: 'Grep', input: { pattern: 'TODO', path: 'src' }, output: 'a.ts\nb.ts' })
    );
    expect(shown).toMatchObject({ kind: 'search', verb: 'Searched for', subject: 'TODO' });
    expect(shown.details).toEqual({
      kind: 'search',
      query: 'TODO',
      scope: 'src',
      output: 'a.ts\nb.ts',
    });
  });

  it('falls back to the raw input for a tool it does not know', () => {
    const shown = presentTool(
      item('mcp__linear__get_issue'),
      detail({ toolName: 'mcp__linear__get_issue', input: { id: 'X-1' } })
    );
    expect(shown).toMatchObject({ kind: 'mcp', verb: 'linear: get issue' });
    expect(shown.details).toEqual({ kind: 'generic', input: '{\n  "id": "X-1"\n}', output: null });
  });

  it('labels from the title alone, and opens to nothing, without details', () => {
    expect(presentTool(item('Edit /a.ts'), null)).toMatchObject({
      kind: 'edit',
      verb: 'Edited',
      subject: '/a.ts',
      details: null,
    });
    expect(presentTool(item('Read'), null)).toMatchObject({
      kind: 'read',
      verb: 'Read a file',
      subject: null,
      details: null,
    });
    expect(presentTool(item('mcp__switch__post_message'), null)).toMatchObject({
      kind: 'switch',
      verb: 'Posted to the room',
      details: null,
    });
    expect(presentTool(item('ToolSearch'), null)).toMatchObject({
      kind: 'other',
      verb: 'ToolSearch',
      details: null,
    });
  });
});

describe('summarizeTools', () => {
  it('counts each kind in the order it first appears', () => {
    expect(summarizeTools(['shell', 'read', 'read', 'edit'])).toEqual({
      label: 'Ran 1 command, read 2 files and edited 1 file',
      kind: null,
    });
    expect(summarizeTools(['read', 'read'])).toEqual({ label: 'Read 2 files', kind: 'read' });
  });
});

it('keeps the end of a long path, which is the part a reader looks for', () => {
  expect(shortPath('/Users/me/repo/src/stores/chat.ts')).toBe('…/src/stores/chat.ts');
  expect(shortPath('src/a.ts')).toBe('src/a.ts');
});
