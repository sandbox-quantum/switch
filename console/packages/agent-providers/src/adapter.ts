import type { ModelChoice, SessionContext } from '@switch-console/shared/session-v1';
import type {
  ApprovalDecision,
  ProviderKind,
  ProviderRuntimeEvent,
  UserInputAnswers,
} from './events';

/**
 * An agent definition in the shape Claude Code's SDK takes it (`AgentDefinition`),
 * restricted to what a Switch agent's settings can set.
 */
export type AgentLaunchDefinition = {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
  maxTurns?: number;
  background?: boolean;
  memory?: 'user' | 'project' | 'local';
};

/**
 * How much the agent may do without asking. Maps onto each vendor's own
 * permission model inside the adapter; orchestration only ever sees this.
 * `auto` is the vendor's own automatic review: safe actions run, risky ones
 * still ask.
 */
export type RuntimeMode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access';

/**
 * The runtime mode an agent's two permission settings select. Bypass
 * (`autoApprove`) wins over auto mode.
 */
export function runtimeModeFor(settings: { autoApprove: boolean; autoMode: boolean }): RuntimeMode {
  if (settings.autoApprove) return 'full-access';
  if (settings.autoMode) return 'auto';
  return 'approval-required';
}

export interface StdioMcpServerSpec {
  transport: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
  envVars?: string[];
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
  /**
   * Servers whose tools follow `runtimeMode` instead of being auto-approved:
   * the granted connectors' (`host/shared-config.ts`). Every other server in
   * {@link mcpServers}, Switch's own above all, is auto-approved in every mode.
   */
  connectorMcpServers: string[];
  /** Extra system-level context appended to whatever the vendor loads itself. */
  systemContext?: string;
  /**
   * A named agent definition the session should run *as* — its system prompt,
   * tool restrictions and model. Claude Code's `--agent <name>`.
   *
   * Without {@link agentDefinition} the vendor must already know the name —
   * Claude Code reads `.claude/agents/<name>.md`, and naming a definition it
   * cannot find is an error there.
   */
  agentName?: string;
  /** The definition of {@link agentName}, handed to the vendor directly instead
   * of read from its own files. */
  agentDefinition?: AgentLaunchDefinition;
  /**
   * Codex only: the session has no auth.json, so an API key the execution
   * machine's Codex keeps in the OS keyring is handed to it as it starts.
   */
  codexKeyringLogin?: CodexKeyringLogin;
}

/**
 * Where a Codex session's keyring login comes from (`codex/keyring-login.ts`).
 * It lives only in the session host's memory: `redact` is a function, so it
 * never reaches a configuration file, and the key itself is read anew each
 * time the session's Codex starts.
 */
export interface CodexKeyringLogin {
  /** The execution machine's own Codex home, whose login is in the keyring. */
  home: string;
  /** The environment Codex reads that login with. */
  env: Record<string, string>;
  /** Called with the key as soon as it is read, so everything the host records scrubs it. */
  redact: (secret: string) => void;
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
  compactSession?(sessionId: string): Promise<void>;
  canCompact?(sessionId: string): Promise<boolean>;
  listModels?(sessionId: string): Promise<ModelChoice[]>;
  setModel?(sessionId: string, model: ModelSelection): Promise<void>;
  /**
   * How full the conversation's context window is now, as the provider
   * measures it; null when it has not said. Absent means it never reports one.
   */
  contextUsage?(sessionId: string): Promise<Omit<SessionContext, 'updatedAt'> | null>;
  /**
   * Adds a developer message to the conversation, read by the model before
   * the next turn with a developer message's weight. Absent means the provider
   * has no such channel; a caller says it in the next user message instead.
   */
  addDeveloperMessage?(sessionId: string, text: string): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  stopAll(): Promise<void>;
  hasSession(sessionId: string): boolean;
  /**
   * Whether the session is still at work outside any turn — subagents started
   * in the background that outlive the turn that started them. A session with
   * background work is not idle. Absent means the provider has none to report.
   */
  hasBackgroundWork?(sessionId: string): boolean;

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

export class ProviderConversationUnavailableError extends ProviderSessionError {}

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
