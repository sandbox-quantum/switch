import type { ItemType } from '../events';

/** One NDJSON line of `agy --output-format stream-json`. */
export interface AntigravityEvent {
  event?: string;
  conversation_id?: string;
  init?: { cwd?: string; tools?: string[]; permission_mode?: string };
  step_update?: StepUpdate;
  result?: TurnResult;
}

export interface StepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: 'ACTIVE' | 'DONE' | 'ERROR' | (string & {});
  step_type?:
    | 'user_input'
    | 'agent_response'
    | 'tool'
    | 'subagent'
    | 'system_message'
    | 'unknown'
    | (string & {});
  text_delta?: string;
  tool_name?: string;
  tool_info?: ToolInfo;
  subagent_info?: { subagents?: Subagent[] };
}

/** One delegated conversation. `conversation_id` only appears once it has started. */
export interface Subagent {
  type_name?: string;
  role?: string;
  initial_prompt?: string;
  conversation_id?: string;
}

export interface ToolInfo {
  name?: string;
  parameters?: Record<string, unknown>;
  output?: string;
  error?: { type?: string; message?: string };
}

export interface TurnResult {
  conversation_id?: string;
  status?: 'SUCCESS' | 'ERROR' | (string & {});
  response?: string;
  error?: string;
  num_turns?: number;
  usage?: Record<string, unknown>;
  denied_actions?: Array<{ action?: string; display_name?: string }>;
}

const ITEM_TYPES: Record<string, ItemType> = {
  run_command: 'command_execution',
  command_status: 'command_execution',
  send_command_input: 'command_execution',
  write_to_file: 'file_change',
  replace_file_content: 'file_change',
  multi_replace_file_content: 'file_change',
  sed_file: 'file_change',
  notebook_edit: 'file_change',
  call_mcp_tool: 'mcp_tool_call',
  search_web: 'web_search',
  read_url_content: 'web_search',
  invoke_subagent: 'subagent',
  define_subagent: 'subagent',
  manage_subagents: 'subagent',
  browser_subagent: 'subagent',
};

export function itemTypeFor(toolName: string): ItemType {
  return ITEM_TYPES[toolName] ?? 'tool_call';
}

/** Parameter keys worth putting in an activity row, most specific first. */
const TITLE_KEYS = [
  'CommandLine',
  'TargetFile',
  'AbsolutePath',
  'DirectoryPath',
  'Query',
  'SearchDirectory',
  'Url',
  'Prompt',
  'ToolName',
  'Name',
];

export function titleFor(
  toolName: string,
  parameters: Record<string, unknown> | undefined
): string {
  if (!parameters) return toolName;
  for (const key of TITLE_KEYS) {
    const value = parameters[key];
    if (typeof value === 'string' && value.trim())
      return `${toolName}: ${value.length > 200 ? `${value.slice(0, 200)}…` : value}`;
  }
  return toolName;
}

export function parseLine(line: string): AntigravityEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as AntigravityEvent) : null;
  } catch {
    return null;
  }
}

/** `agy models` prints a progress line and then `id<TAB>label` rows. */
export function parseModels(stdout: string): Array<{ id: string; label: string }> {
  const models: Array<{ id: string; label: string }> = [];
  for (const line of stdout.split('\n')) {
    const [id, label] = line.split('\t');
    if (!id || !label) continue;
    if (!id.trim() || !label.trim()) continue;
    models.push({ id: id.trim(), label: label.trim() });
  }
  return models;
}
