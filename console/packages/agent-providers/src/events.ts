/**
 * The normalized event stream every provider adapter emits.
 *
 * One vocabulary for all providers so orchestration, status derivation and the
 * transcript UI never see a vendor shape. Adapters translate their native
 * protocol (Claude Agent SDK messages, Codex app-server notifications, OpenCode
 * SSE events) into these; `raw` keeps the native payload for debugging only.
 */

export type ProviderKind = 'opencode' | 'claude' | 'codex' | (string & {});

export type SessionStatus = 'starting' | 'ready' | 'running' | 'stopped' | 'error';

export type TurnOutcome = 'completed' | 'interrupted' | 'error';

/**
 * What an item in a turn represents, independent of how the vendor names it.
 * `tool_call` is the fallback for a tool the vocabulary does not single out.
 */
export type ItemType =
  | 'user_message'
  | 'assistant_message'
  | 'reasoning'
  | 'command_execution'
  | 'file_change'
  | 'mcp_tool_call'
  | 'tool_call'
  | 'web_search'
  | 'subagent'
  | 'context_compaction';

export type ItemStatus = 'in_progress' | 'completed' | 'failed' | 'declined';

export interface ProviderItem {
  id: string;
  type: ItemType;
  status: ItemStatus;
  /** Short human-readable line for activity rows: the command, the file, the tool name. */
  title: string;
  /** Full text for message-shaped items; output/diff for tool-shaped ones. */
  text?: string;
  /** Tool name for `mcp_tool_call` / `tool_call`, agent name for `subagent`. */
  toolName?: string;
  /** For `subagent`: the vendor's id for the child session or thread, when it has one. */
  nativeChildId?: string;
  /** Vendor-specific structured payload preserved verbatim. */
  payload?: Record<string, unknown>;
}

/** Why a provider is blocked waiting for a decision. */
export type RequestType =
  | 'command_execution_approval'
  | 'file_change_approval'
  | 'mcp_tool_approval'
  | 'tool_approval'
  | 'directory_access_approval';

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface ApprovalOption {
  decision: ApprovalDecision;
  label: string;
}

export interface UserInputQuestion {
  id: string;
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string; value: string }>;
  multiSelect: boolean;
  allowCustomAnswer: boolean;
}

/** Keyed by `UserInputQuestion.id`; a value is one option `value` or custom text. */
export type UserInputAnswers = Record<string, string | string[]>;

interface EventBase {
  eventId: string;
  provider: ProviderKind;
  sessionId: string;
  createdAt: string;
  turnId?: string;
  raw?: { source: string; payload: unknown };
}

export type ProviderRuntimeEvent = EventBase &
  (
    | { type: 'session.started'; nativeSessionId: string }
    | { type: 'session.state.changed'; status: SessionStatus; message?: string }
    | { type: 'session.exited'; reason: string }
    | { type: 'turn.started'; turnId: string }
    | { type: 'turn.completed'; turnId: string; outcome: TurnOutcome; message?: string }
    | { type: 'item.started'; turnId: string; item: ProviderItem }
    | { type: 'item.updated'; turnId: string; item: ProviderItem }
    | { type: 'item.completed'; turnId: string; item: ProviderItem }
    /** Assistant text as it streams. Only assistant-message items use this. */
    | { type: 'content.delta'; turnId: string; itemId: string; delta: string }
    /** Incremental output of a tool-shaped item: command stdout, reasoning text, a growing diff. */
    | { type: 'item.delta'; turnId: string; itemId: string; delta: string }
    | {
        type: 'request.opened';
        turnId: string;
        requestId: string;
        requestType: RequestType;
        title: string;
        detail?: string;
        options: ApprovalOption[];
      }
    | { type: 'request.resolved'; requestId: string; decision: ApprovalDecision }
    | {
        type: 'user-input.requested';
        turnId: string;
        requestId: string;
        questions: UserInputQuestion[];
      }
    | { type: 'user-input.resolved'; requestId: string }
    | { type: 'runtime.warning'; message: string }
    | { type: 'runtime.error'; message: string }
  );

export type ProviderRuntimeEventType = ProviderRuntimeEvent['type'];
