import type { McpServerConfig, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerSpec, RuntimeMode } from '../adapter';
import type { ItemType, RequestType, TurnOutcome, UserInputQuestion } from '../events';

const COMMAND_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash']);
const FILE_CHANGE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

const MCP_PREFIX = 'mcp__';

export const PERMISSION_MODE_BY_RUNTIME_MODE = {
  'approval-required': 'default',
  'auto-accept-edits': 'acceptEdits',
  'full-access': 'bypassPermissions',
} as const satisfies Record<RuntimeMode, string>;

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

export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith(MCP_PREFIX);
}

export function itemTypeForTool(toolName: string): ItemType {
  if (COMMAND_TOOLS.has(toolName)) return 'command_execution';
  if (FILE_CHANGE_TOOLS.has(toolName)) return 'file_change';
  if (SUBAGENT_TOOLS.has(toolName)) return 'subagent';
  if (WEB_TOOLS.has(toolName)) return 'web_search';
  if (isMcpTool(toolName)) return 'mcp_tool_call';
  return 'tool_call';
}

export function requestTypeForTool(toolName: string): RequestType {
  if (COMMAND_TOOLS.has(toolName)) return 'command_execution_approval';
  if (FILE_CHANGE_TOOLS.has(toolName)) return 'file_change_approval';
  if (isMcpTool(toolName)) return 'mcp_tool_approval';
  return 'tool_approval';
}

/** For a `subagent` item the vocabulary wants the agent name, not the tool name. */
export function toolNameForItem(toolName: string, input: Record<string, unknown>): string {
  if (SUBAGENT_TOOLS.has(toolName)) return stringField(input, 'subagent_type') ?? toolName;
  return toolName;
}

export function toolTitle(toolName: string, input: Record<string, unknown>): string {
  if (COMMAND_TOOLS.has(toolName)) {
    const command = stringField(input, 'command') ?? stringField(input, 'description');
    return command ? truncate(command) : toolName;
  }
  if (FILE_CHANGE_TOOLS.has(toolName)) {
    const path = stringField(input, 'file_path') ?? stringField(input, 'notebook_path');
    return path ? `${toolName} ${path}` : toolName;
  }
  if (SUBAGENT_TOOLS.has(toolName)) {
    const description = stringField(input, 'description') ?? stringField(input, 'prompt');
    return description ? truncate(description) : toolName;
  }
  if (WEB_TOOLS.has(toolName)) {
    const target = stringField(input, 'query') ?? stringField(input, 'url');
    return target ? truncate(target) : toolName;
  }
  return toolName;
}

/**
 * The CLI stamps a user abort on the result: `aborted_streaming` when the
 * interrupt landed mid-stream, `aborted_tools` when it landed in a tool call.
 * Older CLIs only say so in `errors`.
 */
export function outcomeForResult(result: SDKResultMessage): TurnOutcome {
  const terminal = result.terminal_reason;
  if (terminal === 'aborted_streaming' || terminal === 'aborted_tools') return 'interrupted';
  const errors = resultErrors(result).join(' ').toLowerCase();
  if (errors.includes('interrupt') || errors.includes('request was aborted')) return 'interrupted';
  if (result.subtype === 'success') return 'completed';
  return 'error';
}

/** `[ede_diagnostic] …` entries are CLI-internal telemetry and must not be shown. */
export function resultMessageText(result: SDKResultMessage): string | undefined {
  return resultErrors(result).find((error) => !error.startsWith('[ede_diagnostic]'));
}

function resultErrors(result: SDKResultMessage): string[] {
  const errors = 'errors' in result ? result.errors : undefined;
  return Array.isArray(errors) ? errors.filter((error) => typeof error === 'string') : [];
}

export interface ParsedAskUserQuestion {
  questions: UserInputQuestion[];
  /** Question id to the SDK's own question text, which keys the answers map. */
  questionTextById: Map<string, string>;
}

/**
 * `AskUserQuestionOutput.answers` is keyed by question text with option labels
 * as values, so the labels are also the option values here.
 */
export function parseAskUserQuestionInput(input: Record<string, unknown>): ParsedAskUserQuestion {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const questions: UserInputQuestion[] = [];
  const questionTextById = new Map<string, string>();

  rawQuestions.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const text = stringField(raw, 'question');
    if (!text) return;
    const id = `q${index}`;
    const rawOptions = Array.isArray(raw.options) ? raw.options : [];
    const options = rawOptions.flatMap((option) => {
      if (!isRecord(option)) return [];
      const label = stringField(option, 'label');
      if (!label) return [];
      const description = stringField(option, 'description');
      return [{ label, value: label, ...(description ? { description } : {}) }];
    });
    const header = stringField(raw, 'header');
    questions.push({
      id,
      ...(header ? { header } : {}),
      question: text,
      options,
      multiSelect: raw.multiSelect === true,
      allowCustomAnswer: true,
    });
    questionTextById.set(id, text);
  });

  return { questions, questionTextById };
}

export function toMcpServerConfig(spec: McpServerSpec): McpServerConfig {
  if (spec.transport === 'stdio') {
    return {
      type: 'stdio',
      command: spec.command,
      args: spec.args,
      ...(spec.env ? { env: spec.env } : {}),
    };
  }
  return {
    type: 'http',
    url: spec.url,
    ...(spec.headers ? { headers: spec.headers } : {}),
  };
}

export function textFromToolResultContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((block) => {
    if (!isRecord(block)) return [];
    return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  });
  return parts.length > 0 ? parts.join('\n') : undefined;
}
