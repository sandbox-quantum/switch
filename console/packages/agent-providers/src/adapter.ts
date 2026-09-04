import type {
  ApprovalDecision,
  ProviderKind,
  ProviderRuntimeEvent,
  UserInputAnswers,
} from './events';

/**
 * How much the agent may do without asking. Maps onto each vendor's own
 * permission model inside the adapter; orchestration only ever sees this.
 */
export type RuntimeMode = 'approval-required' | 'auto-accept-edits' | 'full-access';

export interface StdioMcpServerSpec {
  transport: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface HttpMcpServerSpec {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerSpec = StdioMcpServerSpec | HttpMcpServerSpec;

export interface ModelSelection {
  id: string;
  /** Vendor-specific knobs such as reasoning effort or an OpenCode variant. */
  options?: Record<string, string>;
}

export interface ProviderSessionStartInput {
  /** Switch's own session id; the adapter keys everything by it. */
  sessionId: string;
  cwd: string;
  runtimeMode: RuntimeMode;
  /** Resume the vendor's own session/thread instead of starting a fresh one. */
  resume?: { nativeSessionId: string };
  model?: ModelSelection;
  /** Complete environment for any spawned process. Not merged with `process.env`. */
  env: Record<string, string>;
  /** MCP servers the session must expose to the agent, keyed by server name. */
  mcpServers: Record<string, McpServerSpec>;
  /** Extra system-level context appended to whatever the vendor loads itself. */
  systemContext?: string;
  /**
   * A named agent definition the vendor already knows, which the session should
   * run *as* — its system prompt, tool restrictions and model.
   *
   * Claude Code's `--agent <name>`, reading `.claude/agents/<name>.md`. Naming a
   * definition the vendor cannot find is an error there, so a caller passes this
   * only once it knows the definition exists.
   */
  agentName?: string;
}

export interface ProviderSession {
  sessionId: string;
  nativeSessionId: string;
  provider: ProviderKind;
}

export interface TurnAttachment {
  path: string;
  mimeType: string;
}

export interface ProviderSendTurnInput {
  sessionId: string;
  /** Caller-chosen id; the adapter echoes it in turn events for this turn. */
  turnId: string;
  text: string;
  attachments?: TurnAttachment[];
  model?: ModelSelection;
}

export interface ProviderTurnStartResult {
  turnId: string;
  /**
   * When a turn was already running the message was steered into it and this
   * is that turn's id, not the requested one.
   */
  steeredInto?: string;
}

export interface ProviderCapabilities {
  /** The adapter can switch models on a live session, not only at start. */
  modelSwitchInSession: boolean;
  /** A message sent mid-turn joins the running turn instead of queueing behind it. */
  steering: boolean;
  /** The adapter can resume a vendor session after its own process died. */
  resume: boolean;
  /** Permission requests surface as `request.opened` and can be answered. */
  approvals: boolean;
  /** Clarifying questions surface as `user-input.requested` and can be answered. */
  userInput: boolean;
}

/**
 * One adapter instance drives many sessions of one provider. Every method is
 * keyed by Switch's session id; native ids stay inside the adapter.
 *
 * Errors are thrown, never returned. A session that dies emits
 * `session.exited` and then rejects further calls with `ProviderSessionError`.
 */
export interface ProviderAdapter {
  readonly provider: ProviderKind;
  readonly capabilities: ProviderCapabilities;

  startSession(input: ProviderSessionStartInput): Promise<ProviderSession>;
  sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult>;
  interruptTurn(sessionId: string): Promise<void>;
  respondToRequest(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  respondToUserInput(
    sessionId: string,
    requestId: string,
    answers: UserInputAnswers
  ): Promise<void>;
  setModel?(sessionId: string, model: ModelSelection): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  stopAll(): Promise<void>;
  hasSession(sessionId: string): boolean;

  /** Events for every session this adapter drives. Returns the unsubscribe. */
  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void;
}

export class ProviderSessionError extends Error {
  constructor(
    readonly provider: ProviderKind,
    readonly sessionId: string,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(`[${provider}:${sessionId}] ${message}`, options);
    this.name = 'ProviderSessionError';
  }
}

export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: ProviderKind,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(`[${provider}] ${message}`, options);
    this.name = 'ProviderUnavailableError';
  }
}
