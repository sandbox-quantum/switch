import type { RuntimeMode } from '../adapter';

/**
 * Pi's `--mode rpc` protocol, and the dialogs Switch's extension asks through
 * it. Only the fields the adapter reads are typed; Pi sends more.
 * See https://github.com/earendil-works/pi (`packages/coding-agent/docs/rpc*.md`).
 */

/** The model Pi reports, as `get_state` and `get_available_models` describe it. */
export interface PiModel {
  id: string;
  name?: string;
  provider: string;
  input?: string[];
}

/** A model id as Switch names it: `provider/id`, which is what Pi's `--model` takes too. */
export function piModelId(model: Pick<PiModel, 'id' | 'provider'>): string {
  return `${model.provider}/${model.id}`;
}

export interface PiState {
  model?: PiModel;
  isStreaming: boolean;
  sessionFile?: string;
  sessionId: string;
}

export interface PiCommandInfo {
  name: string;
  source: string;
}

export interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
}

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PiMessage {
  role: string;
  content?: string | PiContentBlock[];
  model?: string;
  provider?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
}

export interface PiToolResult {
  content?: PiContentBlock[];
}

/** The session events Pi streams on stdout (`json.md`) that the adapter acts on; it ignores the rest. */
export type PiEvent =
  | { type: 'agent_start' }
  | { type: 'agent_settled'; aborted?: boolean }
  | { type: 'message_start'; message: PiMessage }
  | {
      type: 'message_update';
      assistantMessageEvent: { type: string; delta?: string; contentIndex?: number };
    }
  | { type: 'message_end'; message: PiMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args?: unknown }
  | {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      args?: unknown;
      partialResult?: PiToolResult;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result?: PiToolResult;
      isError?: boolean;
    }
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number; errorMessage?: string }
  | { type: 'auto_retry_end'; success: boolean; finalError?: string }
  | { type: 'extension_error'; extensionPath?: string; event?: string; error?: string };

/** What an extension asks of the client (`rpc-extension-ui.md`). */
export interface PiUiRequest {
  type: 'extension_ui_request';
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export type PiUiResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true };

/** The environment variable that names the file the extension reads its settings from. */
export const SWITCH_EXTENSION_CONFIG_ENV = 'SWITCH_PI_CONFIG';

/** The command the extension registers, which is how the adapter knows it loaded. */
export const SWITCH_EXTENSION_COMMAND = 'switch-session';

/**
 * What the extension is told about the session. The server entries are in
 * Pi's own `mcp.json` shape, already complete, so the extension registers them
 * as they are.
 */
export interface SwitchExtensionConfig {
  runtimeMode: RuntimeMode;
  mcpServers: Record<string, Record<string, unknown>>;
  /** The servers in {@link mcpServers} whose tools follow `runtimeMode`; every other one is always allowed. */
  connectorMcpServers: string[];
}

/** The choices of an approval dialog. The adapter recognises a dialog by these, in this order. */
export const APPROVAL_OPTIONS = ['Allow once', 'Allow for this session', 'Reject'] as const;

/** Marks a dialog Switch's extension opened, so no other extension's dialog is taken for one. */
export const DIALOG_PREFIX = 'switch-pi:';

/**
 * Pi's dialogs carry a title and a list of choices, and nothing else, so what
 * the extension tells the adapter about a dialog rides in the title: this
 * prefix, then JSON. The adapter shows its own words, never this title.
 */
export type SwitchDialog =
  | {
      kind: 'approval';
      toolCallId: string;
      toolName: string;
      /** The MCP server the tool belongs to, when it is one's. */
      server?: string;
      /** Whether that server is a connector, whose tools follow the runtime mode. */
      connector?: boolean;
    }
  | { kind: 'question'; question: string; header?: string; multiSelect: boolean };

export function encodeDialog(dialog: SwitchDialog): string {
  return `${DIALOG_PREFIX}${JSON.stringify(dialog)}`;
}

/** The dialog Switch's extension opened with this title, or undefined for any other. */
export function decodeDialog(title: string | undefined): SwitchDialog | undefined {
  if (!title?.startsWith(DIALOG_PREFIX)) return undefined;
  try {
    const dialog = JSON.parse(title.slice(DIALOG_PREFIX.length)) as SwitchDialog;
    return dialog.kind === 'approval' || dialog.kind === 'question' ? dialog : undefined;
  } catch {
    return undefined;
  }
}
