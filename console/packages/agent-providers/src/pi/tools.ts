import type { RuntimeMode } from '../adapter';
import type { ItemType, ProviderItem, RequestType } from '../events';
import { mcpApprovalContent, toolInputDetail } from '../mcp-approval';
import type { PiToolCallQuestion } from './extension';

const TITLE_LIMIT = 200;

/** Pi's built-in tools that only read. Pi declares no annotations on its built-ins, so they are named. */
const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls']);
const SHELL_TOOLS = new Set(['bash', 'powershell']);
const EDIT_TOOLS = new Set(['edit', 'write']);
/**
 * Pi's tools that reach other tools: every call a codemode script makes, and
 * each tool `tool_search` declares, is asked about on its own when it runs.
 */
const ORCHESTRATING_TOOLS = new Set(['codemode', 'tool_search']);

/**
 * The prefix Pi gives an MCP server's tools: `mcp__<server>__<tool>`, with
 * every character but letters, digits and `_` made `_`.
 */
export function piMcpPrefix(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_]/g, '_')}__`;
}

/** Which of `servers` a tool belongs to, by the longest prefix it carries. */
export function mcpServerOf(toolName: string, servers: Iterable<string>): string | undefined {
  let found: string | undefined;
  for (const server of servers)
    if (
      toolName.startsWith(piMcpPrefix(server)) &&
      (found === undefined || piMcpPrefix(server).length > piMcpPrefix(found).length)
    )
      found = server;
  return found;
}

export interface ToolCallPolicy {
  runtimeMode: RuntimeMode;
  /** The session's MCP servers whose tools run without asking in every mode: all but the connectors. */
  autoApproved: ReadonlySet<string>;
  /** The granted connectors' servers, whose tools follow the runtime mode. */
  connectors: ReadonlySet<string>;
  /** Tools a person allowed for the rest of the session. */
  allowedForSession: ReadonlySet<string>;
}

/**
 * Whether a tool call waits for a person. Pi asks about nothing itself, so
 * this is the whole of a Pi session's approval policy:
 *
 * - The session's own MCP servers (Switch's above all) never ask; the
 *   agent must be able to reach the room it would be asking in.
 * - Full access asks about nothing.
 * - Read-only tools never ask: Pi's own readers, and tools whose server says
 *   they only read and do not destroy.
 * - Auto-accept-edits runs `edit` and `write` too.
 * - Everything else asks, in auto mode as well: Pi has no automatic reviewer
 *   of its own to decide, so auto mode asks as approval-required does.
 */
export function asksPerson(question: PiToolCallQuestion, policy: ToolCallPolicy): boolean {
  const server = mcpServerOf(question.toolName, [...policy.autoApproved, ...policy.connectors]);
  if (server !== undefined && policy.autoApproved.has(server)) return false;
  if (policy.runtimeMode === 'full-access') return false;
  if (policy.allowedForSession.has(question.toolName)) return false;
  if (READ_ONLY_TOOLS.has(question.toolName) || ORCHESTRATING_TOOLS.has(question.toolName))
    return false;
  const hints = question.annotations;
  if (hints?.readOnlyHint === true && hints.destructiveHint !== true) return false;
  return !(policy.runtimeMode === 'auto-accept-edits' && EDIT_TOOLS.has(question.toolName));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function firstLine(value: string): string {
  const line = value.split('\n').find((candidate) => candidate.trim()) ?? value;
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
}

/** What a reader approves: the command, the file, or the MCP tool's input. */
export function approvalRequest(
  question: PiToolCallQuestion,
  connectors: ReadonlySet<string>
): { requestType: RequestType; title: string; detail?: string; connector?: string } {
  const input = record(question.input);
  const connector = mcpServerOf(question.toolName, connectors);
  if (connector !== undefined) {
    const tool = question.toolName.slice(piMcpPrefix(connector).length);
    return {
      requestType: 'mcp_tool_approval',
      ...mcpApprovalContent(connector, tool, input),
      connector,
    };
  }
  if (question.toolName.startsWith('mcp__'))
    return {
      requestType: 'mcp_tool_approval',
      title: `Pi wants to run ${question.toolName}`,
      ...detailOf(input),
    };
  const command = SHELL_TOOLS.has(question.toolName) ? text(input, 'command') : undefined;
  if (command)
    return { requestType: 'command_execution_approval', title: 'Run a command', detail: command };
  const path = EDIT_TOOLS.has(question.toolName) ? text(input, 'path') : undefined;
  if (path)
    return {
      requestType: 'file_change_approval',
      title: question.toolName === 'write' ? 'Write a file' : 'Edit a file',
      detail: path,
    };
  return {
    requestType: 'tool_approval',
    title: `Pi wants to run ${question.toolName}`,
    ...detailOf(input),
  };
}

function detailOf(input: Record<string, unknown>): { detail?: string } {
  const detail = toolInputDetail(input);
  return detail ? { detail } : {};
}

/** A tool call as an activity item, from what Pi says when it starts. */
export function toolItem(
  toolCallId: string,
  toolName: string,
  args: unknown,
  mcpServers: Iterable<string>
): ProviderItem {
  const input = record(args);
  const server = mcpServerOf(toolName, mcpServers);
  let type: ItemType = 'tool_call';
  let title = toolName;
  if (server !== undefined || toolName.startsWith('mcp__')) {
    type = 'mcp_tool_call';
    if (server !== undefined) title = `${server}.${toolName.slice(piMcpPrefix(server).length)}`;
  } else if (SHELL_TOOLS.has(toolName)) {
    type = 'command_execution';
    const command = text(input, 'command');
    if (command) title = firstLine(command);
  } else if (EDIT_TOOLS.has(toolName)) {
    type = 'file_change';
    const path = text(input, 'path');
    if (path) title = `${toolName} ${path}`;
  } else {
    const target = text(input, 'path') ?? text(input, 'pattern') ?? text(input, 'query');
    if (target) title = `${toolName} ${firstLine(target)}`;
  }
  return {
    id: toolCallId,
    type,
    status: 'in_progress',
    title,
    toolName,
    ...(server !== undefined ? { payload: { server } } : {}),
  };
}

/** The text of a Pi tool result (`{ content: [{ type: 'text', text }] }`), images left out. */
export function resultText(result: unknown): string {
  const content = record(result).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (record(part).type === 'text' ? String(record(part).text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/** The exit code Pi's shell tools report in their structured result, when there is one. */
export function exitCodeOf(result: unknown): number | undefined {
  const code = record(record(result).structuredContent).exit_code;
  return typeof code === 'number' ? code : undefined;
}
