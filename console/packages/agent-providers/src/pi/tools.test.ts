import { describe, expect, it } from 'vitest';
import { PI_TOOL_CALL, type PiToolCallQuestion } from './extension';
import { approvalRequest, asksPerson, mcpServerOf, piMcpPrefix, toolItem } from './tools';

function question(toolName: string, input: Record<string, unknown> = {}): PiToolCallQuestion {
  return { switch: PI_TOOL_CALL, toolCallId: 'call-1', toolName, input, annotations: null };
}

describe("Pi's MCP tool names", () => {
  it('carry the server name with every character but letters, digits and _ made _', () => {
    expect(piMcpPrefix('git-hub.v2')).toBe('mcp__git_hub_v2__');
  });

  it('belong to the server with the longest matching prefix', () => {
    expect(mcpServerOf('mcp__a__b__search', ['a', 'a__b'])).toBe('a__b');
    expect(mcpServerOf('mcp__a__search', ['a', 'a__b'])).toBe('a');
    expect(mcpServerOf('bash', ['a'])).toBeUndefined();
  });
});

describe('which tool calls wait for a person', () => {
  const policy = {
    runtimeMode: 'approval-required' as const,
    autoApproved: new Set(['switch']),
    connectors: new Set(['github']),
    allowedForSession: new Set<string>(),
  };

  it('lets codemode and tool search run, since each tool they reach is asked about itself', () => {
    expect(asksPerson(question('codemode', { code: '...' }), policy)).toBe(false);
    expect(asksPerson(question('tool_search', { query: 'x' }), policy)).toBe(false);
  });

  it('asks about a tool that says nothing about itself, as an unknown extension tool does', () => {
    expect(asksPerson(question('deploy'), policy)).toBe(true);
  });

  it('asks in auto mode as approval-required does, since Pi has no reviewer of its own', () => {
    expect(
      asksPerson(question('bash', { command: 'ls' }), { ...policy, runtimeMode: 'auto' })
    ).toBe(true);
  });
});

describe('what an approval shows', () => {
  it("names a tool from the user's own MCP servers in full", () => {
    expect(approvalRequest(question('mcp__notes__delete', { id: 3 }), new Set())).toEqual({
      requestType: 'mcp_tool_approval',
      title: 'Pi wants to run mcp__notes__delete',
      detail: '{"id":3}',
    });
  });

  it('falls back to the tool and its input when a command has none', () => {
    expect(approvalRequest(question('bash', {}), new Set())).toEqual({
      requestType: 'tool_approval',
      title: 'Pi wants to run bash',
    });
  });
});

describe('a tool call as an activity row', () => {
  it('reads as what it reads or looks for', () => {
    expect(toolItem('c', 'read', { path: 'src/a.ts' }, []).title).toBe('read src/a.ts');
    expect(toolItem('c', 'grep', { pattern: 'TODO' }, []).title).toBe('grep TODO');
  });

  it('names an MCP tool by its server and tool', () => {
    expect(toolItem('c', 'mcp__switch__send_message', {}, ['switch'])).toMatchObject({
      type: 'mcp_tool_call',
      title: 'switch.send_message',
      payload: { server: 'switch' },
    });
  });
});
