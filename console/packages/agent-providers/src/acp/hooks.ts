import type { ProviderCapabilities, RuntimeMode } from '../adapter';
import type {
  ApprovalDecision,
  ItemType,
  ProviderItem,
  RequestType,
  UserInputQuestion,
} from '../events';
import type { ProviderReadiness, SignInCheckInput } from '../readiness';
import type { ProviderLogger } from '../transport/stdio-json-rpc';
import type {
  AcpInitializeResult,
  AcpPermissionRequest,
  AcpPromptCapabilities,
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
}

export interface AcpLaunchInput {
  binaryPath: string;
  cwd: string;
  env: Record<string, string>;
}

/** One answered question: the option values chosen, already checked against what was offered. */
export interface AcpSelectedAnswer {
  questionId: string;
  values: string[];
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
  /** The command a person runs on the execution machine to sign the CLI in. */
  loginCommand: string;
  /**
   * Environment variables the CLI reads (an API key, an endpoint) that a
   * session host should pass through from the machine's environment. The
   * common vendor keys are already passed through for every provider.
   */
  inheritEnv?: readonly string[];
  /**
   * Whether the CLI is signed in, answered without signing it in: a check
   * must never be what changes its answer. `handshake` runs the agent and
   * returns its `initialize` answer. Without this hook the check runs the
   * handshake and reports the sign-in as unknown.
   */
  checkSignIn?(input: AcpSignInInput): Promise<ProviderReadiness>;
  /**
   * `authenticate` method sent after `initialize` on every session start,
   * which may open a browser. Omit for an agent that needs no sign-in call.
   */
  authMethodId?: string;
  /**
   * Prompt content the agent accepts whether or not it advertises it. What it
   * advertises in `initialize` is always honoured as well.
   */
  promptCapabilities?: AcpPromptCapabilities;
  /** The ACP mode to put a new session in for Switch's runtime mode. Omit to leave the agent's default. */
  sessionMode?(runtimeMode: RuntimeMode): string;
  /**
   * Native session ids are stored with this prefix, telling them apart from
   * ids an earlier, non-ACP runtime of the same provider stored. A resume id
   * without it starts a fresh conversation with `legacyMessage`.
   */
  nativeSessionIdPrefix?: { prefix: string; legacyMessage: string };
  /** The MCP server a tool call belongs to, when the agent says so. */
  mcpServerOf?(toolCall: AcpToolCall): string | undefined;
  /** Vendor item typing, consulted before the protocol's own `kind`. */
  itemType?(toolCall: AcpToolCall): ItemType | undefined;
  /**
   * A permission request the vendor uses for something else (a question, say).
   * Return undefined to let the adapter treat it as a permission request.
   */
  permission?(
    context: AcpSessionContext,
    request: AcpPermissionRequest
  ): Promise<unknown> | undefined;
  /** Register vendor-specific requests and notifications for a session. */
  extensions?(context: AcpSessionContext, on: AcpExtensionRegistrar): void;
}

export interface AcpSignInInput extends SignInCheckInput {
  handshake(): Promise<AcpInitializeResult>;
}

export interface AcpAdapterOptions {
  binaryPath?: string;
  logger?: ProviderLogger;
}
