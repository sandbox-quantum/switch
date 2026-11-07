import type { RuntimeMode } from '../adapter';
import type { ItemType, RequestType } from '../events';
import { mcpApprovalContent, toolInputDetail } from '../mcp-approval';

/** Amp's built-in tool names, as its stream-JSON `init.tools` lists them (amp 0.0.1794110442). */
const COMMAND_TOOLS = new Set(['bash', 'shell_command', 'code_exec']);
const FILE_CHANGE_TOOLS = new Set(['create_file', 'edit_file', 'undo_edit', 'apply_patch']);
const WEB_TOOLS = new Set(['web_search', 'read_web_page']);
const SUBAGENT_TOOLS = new Set(['task', 'oracle', 'librarian', 'finder']);
/** Tools that only read: run without asking outside full access, as every ACP agent's do. */
const READ_ONLY_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'list_directory',
  'todo_read',
  'todo_write',
  'tool_search',
  'read_thread',
  'get_diagnostics',
  'format_file',
  'look_at',
  'skill',
  'load_prompt',
  'view_media',
  'shell_command_status',
  'shell_command_kill',
  'set_thread_status',
  'wait_for_threads',
  'subagent_stop',
  ...WEB_TOOLS,
  ...SUBAGENT_TOOLS,
]);

const MCP_PREFIX = 'mcp__';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function truncate(value: string, max = 160): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

/** The server and tool in Amp's `mcp__<server>__<tool>` name. */
export function mcpToolParts(toolName: string): { server: string; tool: string } | undefined {
  if (!toolName.startsWith(MCP_PREFIX)) return undefined;
  const rest = toolName.slice(MCP_PREFIX.length);
  const split = rest.indexOf('__');
  if (split <= 0 || split + 2 >= rest.length) return undefined;
  return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

const lower = (toolName: string) => toolName.toLowerCase();

export function itemTypeForTool(toolName: string): ItemType {
  const name = lower(toolName);
  if (COMMAND_TOOLS.has(name)) return 'command_execution';
  if (FILE_CHANGE_TOOLS.has(name)) return 'file_change';
  if (SUBAGENT_TOOLS.has(name)) return 'subagent';
  if (WEB_TOOLS.has(name)) return 'web_search';
  if (mcpToolParts(toolName)) return 'mcp_tool_call';
  return 'tool_call';
}

export function requestTypeForTool(toolName: string): RequestType {
  const name = lower(toolName);
  if (COMMAND_TOOLS.has(name)) return 'command_execution_approval';
  if (FILE_CHANGE_TOOLS.has(name)) return 'file_change_approval';
  if (mcpToolParts(toolName)) return 'mcp_tool_approval';
  return 'tool_approval';
}

export function isBackgroundSubagentCall(
  toolName: string,
  input: Record<string, unknown>
): boolean {
  return lower(toolName) === 'task' && input.mode === 'async';
}

export function toolTitle(toolName: string, input: Record<string, unknown>): string {
  const name = lower(toolName);
  if (COMMAND_TOOLS.has(name)) {
    const command = stringField(input, 'cmd') ?? stringField(input, 'command');
    return command ? truncate(command) : toolName;
  }
  if (FILE_CHANGE_TOOLS.has(name)) {
    const path = stringField(input, 'path') ?? stringField(input, 'file_path');
    return path ? `${toolName} ${path}` : toolName;
  }
  if (SUBAGENT_TOOLS.has(name)) {
    const description =
      stringField(input, 'description') ??
      stringField(input, 'prompt') ??
      stringField(input, 'task');
    return description ? truncate(description) : toolName;
  }
  if (WEB_TOOLS.has(name)) {
    const target = stringField(input, 'query') ?? stringField(input, 'url');
    return target ? truncate(target) : toolName;
  }
  const mcp = mcpToolParts(toolName);
  if (mcp) return `${mcp.server}.${mcp.tool}`;
  return toolName;
}

export type ToolPolicy =
  | { kind: 'allow' }
  | { kind: 'ask'; requestType: RequestType; title: string; detail?: string; connector?: string };

/**
 * What Switch does with a tool call Amp's plugin asks about, in each runtime
 * mode. Full access allows everything. Otherwise a tool on a server the
 * session registered itself (Switch's own) is allowed, a connector's asks,
 * read-only tools run, edits run in auto and auto-accept-edits, and commands
 * and anything unknown ask. Amp has no reviewer of its own, so auto mode is
 * its edits-run mode, as Antigravity's is.
 */
export function toolPolicy(input: {
  runtimeMode: RuntimeMode;
  tool: string;
  toolInput: Record<string, unknown>;
  command: string | null;
  autoApprovedMcpServers: ReadonlySet<string>;
  connectorMcpServers: ReadonlySet<string>;
}): ToolPolicy {
  if (input.runtimeMode === 'full-access') return { kind: 'allow' };
  const mcp = mcpToolParts(input.tool);
  if (mcp) {
    if (input.autoApprovedMcpServers.has(mcp.server)) return { kind: 'allow' };
    return {
      kind: 'ask',
      requestType: 'mcp_tool_approval',
      ...mcpApprovalContent(mcp.server, mcp.tool, input.toolInput),
      ...(input.connectorMcpServers.has(mcp.server) ? { connector: mcp.server } : {}),
    };
  }
  const name = lower(input.tool);
  if (input.command !== null || COMMAND_TOOLS.has(name)) {
    const command = input.command ?? toolTitle(input.tool, input.toolInput);
    return {
      kind: 'ask',
      requestType: 'command_execution_approval',
      title: `Run a ${input.tool} command`,
      detail: command,
    };
  }
  if (READ_ONLY_TOOLS.has(name)) return { kind: 'allow' };
  if (FILE_CHANGE_TOOLS.has(name)) {
    if (input.runtimeMode === 'auto' || input.runtimeMode === 'auto-accept-edits')
      return { kind: 'allow' };
    return {
      kind: 'ask',
      requestType: 'file_change_approval',
      title: toolTitle(input.tool, input.toolInput),
    };
  }
  const detail = toolInputDetail(input.toolInput);
  return {
    kind: 'ask',
    requestType: 'tool_approval',
    title: `Run ${input.tool}`,
    ...(detail ? { detail } : {}),
  };
}

export function textFromToolResultContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((block) =>
    isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  );
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** The modes Amp's Dial offers, which a Switch agent chooses as its model. */
export const AMP_MODES: { id: string; label: string }[] = [
  { id: 'low', label: 'low — small, well-defined tasks' },
  { id: 'medium', label: 'medium — Amp’s default' },
  { id: 'high', label: 'high — hard tasks, more reasoning' },
  { id: 'ultra', label: 'ultra — hard, open-ended work' },
];
