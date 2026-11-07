import { describe, expect, it } from 'vitest';
import {
  AMP_MODES,
  isBackgroundSubagentCall,
  itemTypeForTool,
  mcpToolParts,
  requestTypeForTool,
  toolPolicy,
  toolTitle,
} from './amp-mapping';

const servers = {
  autoApprovedMcpServers: new Set(['switch']),
  connectorMcpServers: new Set(['github']),
};

describe('Amp tool mapping', () => {
  it('types Amp’s built-in tools', () => {
    expect(itemTypeForTool('Bash')).toBe('command_execution');
    expect(itemTypeForTool('edit_file')).toBe('file_change');
    expect(itemTypeForTool('create_file')).toBe('file_change');
    expect(itemTypeForTool('Task')).toBe('subagent');
    expect(itemTypeForTool('oracle')).toBe('subagent');
    expect(itemTypeForTool('web_search')).toBe('web_search');
    expect(itemTypeForTool('mcp__switch__send_message')).toBe('mcp_tool_call');
    expect(itemTypeForTool('todo_write')).toBe('tool_call');
  });

  it('reads the server and tool out of an MCP tool name', () => {
    expect(mcpToolParts('mcp__switch__send_message')).toEqual({
      server: 'switch',
      tool: 'send_message',
    });
    expect(mcpToolParts('Bash')).toBeUndefined();
    expect(mcpToolParts('mcp__broken')).toBeUndefined();
  });

  it('titles a command by its command and a file tool by its path', () => {
    expect(toolTitle('Bash', { cmd: 'ls -la' })).toBe('ls -la');
    expect(toolTitle('edit_file', { path: 'src/a.ts' })).toBe('edit_file src/a.ts');
    expect(toolTitle('Task', { description: 'Read the README' })).toBe('Read the README');
    expect(toolTitle('mcp__switch__send_message', {})).toBe('switch.send_message');
  });

  it('knows a background subagent from the Task input', () => {
    expect(isBackgroundSubagentCall('Task', { mode: 'async' })).toBe(true);
    expect(isBackgroundSubagentCall('Task', {})).toBe(false);
    expect(isBackgroundSubagentCall('Bash', { mode: 'async' })).toBe(false);
  });

  it('maps request types', () => {
    expect(requestTypeForTool('Bash')).toBe('command_execution_approval');
    expect(requestTypeForTool('create_file')).toBe('file_change_approval');
    expect(requestTypeForTool('mcp__github__create_issue')).toBe('mcp_tool_approval');
    expect(requestTypeForTool('code_exec')).toBe('command_execution_approval');
    expect(requestTypeForTool('something_new')).toBe('tool_approval');
  });

  it('offers the Dial modes as models', () => {
    expect(AMP_MODES.map((mode) => mode.id)).toEqual(['low', 'medium', 'high', 'ultra']);
  });
});

describe('Amp tool policy', () => {
  const policy = (
    runtimeMode: Parameters<typeof toolPolicy>[0]['runtimeMode'],
    tool: string,
    toolInput: Record<string, unknown> = {},
    command: string | null = null
  ) => toolPolicy({ runtimeMode, tool, toolInput, command, ...servers });

  it('allows everything in full access', () => {
    expect(policy('full-access', 'Bash', { cmd: 'rm -rf /' }, 'rm -rf /')).toEqual({
      kind: 'allow',
    });
    expect(policy('full-access', 'mcp__github__create_issue')).toEqual({ kind: 'allow' });
  });

  it('asks about a command, with the command as the detail', () => {
    expect(policy('approval-required', 'Bash', { cmd: 'echo hi' }, 'echo hi')).toEqual({
      kind: 'ask',
      requestType: 'command_execution_approval',
      title: 'Run a Bash command',
      detail: 'echo hi',
    });
    expect(policy('auto', 'Bash', { cmd: 'echo hi' }, 'echo hi').kind).toBe('ask');
  });

  it('allows a tool on the session’s own MCP server and asks about a connector’s', () => {
    expect(policy('approval-required', 'mcp__switch__send_message', { text: 'hi' })).toEqual({
      kind: 'allow',
    });
    expect(policy('approval-required', 'mcp__github__create_issue', { title: 'x' })).toEqual({
      kind: 'ask',
      requestType: 'mcp_tool_approval',
      title: 'github wants to run create_issue',
      detail: '{"title":"x"}',
      connector: 'github',
    });
    expect(policy('approval-required', 'mcp__other__tool')).toMatchObject({
      kind: 'ask',
      requestType: 'mcp_tool_approval',
    });
  });

  it('lets read-only tools run and asks about edits unless edits are auto-accepted', () => {
    expect(policy('approval-required', 'Read', { path: 'a' })).toEqual({ kind: 'allow' });
    expect(policy('approval-required', 'Grep')).toEqual({ kind: 'allow' });
    expect(policy('approval-required', 'Task', { description: 'x' })).toEqual({ kind: 'allow' });
    expect(policy('approval-required', 'shell_command_status', { id: 'p1' })).toEqual({
      kind: 'allow',
    });
    expect(policy('approval-required', 'skill', { name: 'switch' })).toEqual({ kind: 'allow' });
    expect(policy('approval-required', 'edit_file', { path: 'a.ts' })).toEqual({
      kind: 'ask',
      requestType: 'file_change_approval',
      title: 'edit_file a.ts',
    });
    expect(policy('auto-accept-edits', 'edit_file', { path: 'a.ts' })).toEqual({ kind: 'allow' });
    expect(policy('auto', 'create_file', { path: 'a.ts' })).toEqual({ kind: 'allow' });
  });

  it('asks about a tool it does not know, showing its input', () => {
    expect(policy('approval-required', 'deploy_everything', { target: 'prod' })).toEqual({
      kind: 'ask',
      requestType: 'tool_approval',
      title: 'Run deploy_everything',
      detail: '{"target":"prod"}',
    });
  });
});
