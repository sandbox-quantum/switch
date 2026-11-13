import type { McpServerSpec, ProviderCapabilities, RuntimeMode } from '../adapter';
import type {
  ApprovalDecision,
  ItemType,
  ProviderItem,
  RequestType,
  UserInputQuestion,
} from '../events';
import type { ProviderReadiness, SignInCheckInput } from '../readiness';
import type { ProviderLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';
import type {
  AcpAgentCapabilities,
  AcpConfigOption,
  AcpInitializeResult,
  AcpPermissionRequest,
  AcpPromptCapabilities,
  AcpSessionModes,
  AcpToolCall,
} from './protocol';

/** The process an ACP provider runs as. */
export interface AcpLaunch {
  command: string;
  args: string[];
  /** Complete environment for the process; not merged with anything. */
  env: Record<string, string>;
  /**
   * Looks at each line the process prints and returns a message to kill it
   * with, for output that means it can never answer (an interactive sign-in
   * prompt, say).
   */
  rejectOutputLine?: (line: string) => string | undefined;
  /** Removes what `launch` prepared for this process, once the process is gone. */
  cleanup?: () => Promise<void>;
  /**
   * The agent exits by itself once its input closes, saving its sessions as
   * it goes, and a signal would cut that short: it is stopped by closing its
   * input, and killed only if it is still running 2 s later.
   */
  exitsOnClosedInput?: boolean;
}

export interface AcpLaunchInput {
  binaryPath: string;
  cwd: string;
  env: Record<string, string>;
  /**
   * The session's runtime mode, for an agent whose permission policy is set
   * when it starts rather than through `session/set_mode`. Absent when the
   * launch is for a sign-in check.
   */
  runtimeMode?: RuntimeMode;
  /**
   * The session's MCP servers; none for a sign-in check. Only a provider with
   * `mcpServersAtLaunch` uses them here: every other agent is given them in
   * `session/new`.
   */
  mcpServers?: Record<string, McpServerSpec>;
}

/**
 * One answered question: the option values chosen, already checked against
 * what was offered, and the text typed where the question takes it.
 */
export interface AcpSelectedAnswer {
  questionId: string;
  values: string[];
  custom?: string;
}

/**
 * What a provider's vendor extensions can do inside a running session. Every
 * call is a no-op answer (`cancelled`) when no turn is running or the turn was
 * interrupted, so an extension never has to check that itself.
 */
export interface AcpSessionContext {
  /** The running turn, or null when there is none or it was interrupted. */
  readonly turnId: string | null;
  /** Names of the MCP servers this session registered. */
  readonly mcpServerNames: ReadonlySet<string>;
  /**
   * Ask the user questions. Resolves with what `answer` returns for the
   * user's choices, or ACP's `cancelled` outcome when the turn ends first.
   */
  askQuestions(
    questions: UserInputQuestion[],
    answer: (selected: AcpSelectedAnswer[]) => unknown
  ): Promise<unknown>;
  /**
   * Ask the user for a decision. Resolves with the `response` of the option
   * chosen. `cancel` (and `decline`, when not offered) resolve with ACP's
   * `cancelled` outcome.
   */
  requestDecision(input: {
    requestType: RequestType;
    title: string;
    detail?: string;
    options: Array<{ decision: ApprovalDecision; label: string; response: unknown }>;
    /** The connector server whose tool this asks to run, if it is one. */
    connector?: string;
  }): Promise<unknown>;
  /** Add a finished item to the running turn's transcript. */
  completeItem(item: ProviderItem): void;
}

export interface AcpExtensionRegistrar {
  request(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void;
  notification(method: string, handler: (params: unknown) => void): void;
}

/**
 * Everything that makes one ACP-speaking CLI different from another. The
 * generic adapter covers the protocol and picks behaviour from the agent's
 * advertised capabilities; these hooks cover the rest.
 */
export interface AcpProviderHooks {
  /** Provider id, as Switch stores it. */
  provider: string;
  /** How messages name the CLI: "Cursor CLI", "Antigravity". */
  label: string;
  /** Executable used when the caller names none. */
  defaultBinary: string;
  capabilities: ProviderCapabilities;
  /** The command, arguments and environment to run the agent with. May prepare the host first. */
  launch(input: AcpLaunchInput): Promise<AcpLaunch> | AcpLaunch;
  /**
   * The agent ignores the MCP servers a client sends in `session/new` and
   * reads its own configuration instead, so `launch` writes the session's
   * servers there. `session/new` is then sent an empty list, and the
   * MCP-over-HTTP check is skipped: the agent's own MCP client connects.
   */
  mcpServersAtLaunch?: boolean;
  /** The command a person runs on the execution machine to sign the CLI in. */
  loginCommand: string;
  /**
   * The sign-in command for the executable at `binaryPath`, where it is not
   * `loginCommand` for every one (an older runtime of the same provider, say).
   */
  loginCommandFor?(binaryPath: string): string;
  /**
   * Environment variables the CLI reads (an API key, an endpoint) that a
   * session host should pass through from the machine's environment. The
   * common vendor keys are already passed through for every provider.
   */
  inheritEnv?: readonly string[];
  /** The platforms the agent cannot run on, each with the reason a person is told. */
  unsupportedPlatforms?: Partial<Record<NodeJS.Platform, string>>;
  /**
   * Whether the CLI is signed in, answered without signing it in: a check
   * must never be what changes its answer. `handshake` runs the agent and
   * returns its `initialize` answer. Without this hook the check runs the
   * handshake and reports the sign-in as unknown. `request` asks the same
   * process something more after the handshake.
   */
  checkSignIn?(input: AcpSignInInput): Promise<ProviderReadiness>;
  /**
   * `authenticate` method sent after `initialize` when a session starts with
   * this environment, which may open a browser; undefined sends none (the
   * session environment already signs it in, say). Omit for an agent that
   * never needs a sign-in call. `binaryPath` is the executable the session runs.
   */
  authMethodId?(env: Record<string, string>, binaryPath: string): string | undefined;
  /**
   * Whether the agent is signed in already, asked after `initialize` and
   * before `authenticate` is sent for `authMethodId`; true sends none. For an
   * agent that keeps the method it is sent, where `authenticate` would move a
   * signed-in CLI onto another method for good. Absent always sends it.
   */
  alreadySignedIn?(input: AcpSignedInQuery): Promise<boolean>;
  /**
   * Prompt content the agent accepts whether or not it advertises it. What it
   * advertises in `initialize` is always honoured as well.
   */
  promptCapabilities?: AcpPromptCapabilities;
  /**
   * MCP transports the agent accepts whether or not it advertises them. What
   * it advertises in `initialize` is always honoured as well.
   */
  mcpCapabilities?: AcpAgentCapabilities['mcpCapabilities'];
  /**
   * The ACP mode to put a new session in for Switch's runtime mode, given the
   * modes the session advertised. Omit, or return undefined, to leave the
   * agent's default.
   */
  sessionMode?(runtimeMode: RuntimeMode, modes: AcpSessionModes | undefined): string | undefined;
  /**
   * Session config options to set for Switch's runtime mode, for an agent
   * whose permission level is a config option rather than a mode (Junie's
   * brave mode). Given the options the new session offers; each value must be
   * one its option offers, or the session does not start.
   */
  sessionConfigOptions?(
    runtimeMode: RuntimeMode,
    options: AcpConfigOption[]
  ): Record<string, string>;
  /**
   * Permission option kinds that outlive the session on this agent (Junie's
   * `allow_always` writes its allowlist for every later run). Never offered.
   */
  persistentPermissionKinds?: readonly string[];
  /**
   * Native session ids are stored with this prefix, telling them apart from
   * ids an earlier, non-ACP runtime of the same provider stored. A resume id
   * without it starts a fresh conversation with `legacyMessage`.
   */
  nativeSessionIdPrefix?: { prefix: string; legacyMessage: string };
  /**
   * The MCP server a tool call belongs to, when the agent says so. `servers`
   * names the session's registered servers. A permission request is asked
   * about with its own call first, then with the latest announcement or
   * update of that call this answered for, and the request's call is
   * `request` both times: an agent may name the server only across the two.
   */
  mcpServerOf?(
    toolCall: AcpToolCall,
    servers: ReadonlySet<string>,
    request?: AcpToolCall
  ): string | undefined;
  /** Vendor item typing, consulted before the protocol's own `kind`. */
  itemType?(toolCall: AcpToolCall): ItemType | undefined;
  /**
   * A title for a tool call whose own title is only the tool's name (DeepSeek
   * Harness): the command it runs, the file it writes. Undefined keeps the
   * agent's title.
   */
  toolTitle?(toolCall: AcpToolCall): string | undefined;
  /**
   * The ACP `kind` of a tool call, for an agent that doesn't label its tools
   * (Cline marks every one `other`). Consulted before the call's own `kind`;
   * it decides which approval a call needs and the card it shows as.
   */
  toolKind?(toolCall: AcpToolCall): string | undefined;
  /**
   * A permission request the vendor uses for something else (a question, say).
   * Return undefined to let the adapter treat it as a permission request.
   */
  permission?(
    context: AcpSessionContext,
    request: AcpPermissionRequest
  ): Promise<unknown> | undefined;
  /**
   * Client capabilities announced in `initialize` beyond the protocol's own,
   * for requests the provider's `extensions` answer (`elicitation`, say).
   */
  clientCapabilities?: Record<string, unknown>;
  /** Register vendor-specific requests and notifications for a session. */
  extensions?(context: AcpSessionContext, on: AcpExtensionRegistrar): void;
}

export interface AcpSignedInQuery {
  binaryPath: string;
  env: Record<string, string>;
  /** A request to the agent the session started. */
  request<T>(method: string, params: unknown): Promise<T>;
}

/** The agent's connection, for a sign-in check that must ask it more than `initialize`. */
export type AcpConnection = Pick<StdioJsonRpcClient, 'request' | 'onNotification'>;

export interface AcpSignInInput extends SignInCheckInput {
  handshake(): Promise<AcpInitializeResult>;
  /** A request to the process `handshake` started; fails when it has not run. */
  request<T>(method: string, params: unknown): Promise<T>;
  /** The connection `handshake` opened; throws before it has. */
  connection(): AcpConnection;
}

export interface AcpAdapterOptions {
  binaryPath?: string;
  logger?: ProviderLogger;
}
