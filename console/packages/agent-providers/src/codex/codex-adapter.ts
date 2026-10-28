import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import {
  type CodexKeyringLogin,
  type ModelSelection,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderSendTurnInput,
  type ProviderSession,
  ProviderSessionError,
  ProviderConversationUnavailableError,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type RuntimeMode,
} from '../adapter';
import type {
  ApprovalDecision,
  ApprovalOption,
  ProviderRuntimeEvent,
  RequestType,
  SessionStatus,
  TokenUsage,
  TurnOutcome,
  UserInputAnswers,
  UserInputQuestion,
} from '../events';
import {
  StdioJsonRpcClient,
  JsonRpcError,
  noopLogger,
  type ProviderLogger,
} from '../transport/stdio-json-rpc';
import { CumulativeUsage, mergeUsage, type UsageCounts } from '../usage';
import { featureArgs, mcpServerConfigArgs, tomlString } from './config-args';
import { mapCodexItem } from './item-mapping';
import { CODEX_KEYRING_READ_TIMEOUT_MS, readCodexKeyringApiKey } from './keyring-login';
import {
  CODEX_CLIENT_METHODS,
  CODEX_CLIENT_NOTIFICATIONS,
  CODEX_SERVER_NOTIFICATIONS,
  CODEX_SERVER_REQUESTS,
  type CodexApprovalsReviewer,
  type CodexAskForApproval,
  type CodexSandboxMode,
  type CodexThreadTokenUsageUpdatedNotification,
  type CodexTokenUsageBreakdown,
  type CodexCommandExecutionApprovalParams,
  type CodexDeltaNotification,
  type CodexErrorNotification,
  type CodexFileChangeApprovalParams,
  type CodexInitializeParams,
  type CodexItemNotification,
  type CodexMcpElicitationParams,
  type CodexMcpToolCallMeta,
  type CodexPermissionsApprovalParams,
  type CodexThreadItem,
  type CodexThreadOpenResponse,
  type CodexThreadStatusChangedNotification,
  type CodexToolRequestUserInputParams,
  type CodexTurnNotification,
  type CodexTurnStartResponse,
  type CodexTurnSteerResponse,
  type CodexUserInput,
} from './protocol';

const PROVIDER = 'codex';
const CLIENT_NAME = 'switch-console';
const CLIENT_VERSION = '0.1.0';

export const CODEX_SIGN_IN_REQUIRED = 'Sign in on the execution machine with codex login.';

/**
 * Signed out with no auth.json on the machine: Codex reads a keyring login as
 * signed out when the keyring refuses it, so that is the likely cause when
 * `codex login status` disagrees.
 */
export const CODEX_KEYRING_SIGN_IN_REQUIRED =
  `${CODEX_SIGN_IN_REQUIRED} If Codex there says it is already signed in, it could not read ` +
  'the login it keeps in the OS keyring: the keychain may be locked, or access to its ' +
  '"Codex Auth" item may have been denied.';

/**
 * Where a session that is handed a keyring login keeps it: in the memory of
 * its own Codex process, never in a file or the keyring. Given on the command
 * line, it outranks the user's and the project's configuration, and survives
 * Codex falling back to its defaults over a configuration it cannot read.
 */
const EPHEMERAL_LOGIN_ARGS = ['-c', 'cli_auth_credentials_store="ephemeral"'];

const accountSchema = z.object({
  account: z.unknown().nullable(),
  requiresOpenaiAuth: z.boolean(),
});

/**
 * `multi_agent_v2` ships stable but off, and it is what puts `spawn_agent` in
 * the model's tool set — without it a delegation request is answered inline and
 * no subagent item ever reaches the transcript.
 */
const DEFAULT_FEATURES: Record<string, boolean> = { multi_agent_v2: true };

export interface CodexAdapterOptions {
  /** Defaults to `codex` on PATH. */
  binaryPath?: string;
  logger?: ProviderLogger;
  /** app-server feature flags, layered over the adapter's own defaults. */
  features?: Record<string, boolean>;
}

interface PendingApproval {
  settle: (decision: ApprovalDecision) => void;
}

interface PendingUserInput {
  settle: (answers: UserInputAnswers) => void;
}

/** `Omit` collapses a union, so peel the metadata off each member instead. */
type EmittableEvent<T = ProviderRuntimeEvent> = T extends ProviderRuntimeEvent
  ? Omit<T, 'eventId' | 'provider' | 'sessionId' | 'createdAt'>
  : never;

interface CodexSessionState {
  sessionId: string;
  threadId: string;
  client: StdioJsonRpcClient;
  model?: string;
  effort?: string;
  compaction?: { resolve: () => void; reject: (error: Error) => void };
  activeNativeTurnId?: string;
  /** Caller turn ids handed to `turn/start` but not yet bound to a native id. */
  unboundTurnIds: string[];
  turnIdByNative: Map<string, string>;
  approvals: Map<string, PendingApproval>;
  userInputs: Map<string, PendingUserInput>;
  items: Map<string, CodexThreadItem>;
  deltaBuffers: Map<string, string>;
  stopping: boolean;
  exited: boolean;
  /**
   * Codex reports one running total for the thread and never names the
   * model, so a turn's spend is the difference from the last report,
   * attributed to the model selected at the time (empty for the default).
   * A resumed thread's total includes everything spent before this process
   * opened it, so counting starts from the first report less its last call.
   */
  usage: CumulativeUsage;
  unreportedUsage: TokenUsage[];
  /** The last model call's size against the window, cleared when a compaction makes it stale. */
  context?: { usedTokens: number; windowTokens: number | null };
  /** Servers whose tool calls Codex asks about, rather than approving them itself. */
  connectorMcpServers: Set<string>;
}

interface ThreadModeConfig {
  /** Sent with the thread; null leaves the policy to the configuration the process was started with. */
  approvalPolicy: CodexAskForApproval | null;
  /** Who answers an approval request: the person, or Codex's own automatic review. */
  approvalsReviewer: CodexApprovalsReviewer;
  /** `-c` overrides for the `codex app-server` process. */
  configArgs: string[];
}

/**
 * How each runtime mode reaches Codex.
 *
 * Approval-required once sent `approvalPolicy: "untrusted"`, which asked
 * before every command outside Codex's small safe list. Codex retired that
 * value (0.162 refuses it in configuration, and its migration guide says to
 * remove it); the replacement it documents is marking the working directory
 * `trust_level = "untrusted"`, under which commands need approval unless an
 * execution-policy rule allows them. `on-request` is not that: it runs
 * anything the sandbox permits without asking. The mark goes on this
 * process's command line as an inline table, which replaces the user's own
 * `projects` entries for the process, so the `trusted` entry Console writes
 * for the directory does not override it. Verified against 0.162.1: a plain
 * `date` and an MCP tool call both ask, and a symlinked directory matches as
 * long as `cwd` is spelt the same way in both places. One consequence named
 * in Codex's guide: an untrusted project does not load its own `.codex/`
 * configuration.
 *
 * Auto is `on-request` with Codex's automatic reviewer (`auto_review`)
 * answering the approval requests the sandbox raises, which is why auto never
 * runs unsandboxed (see `sandboxFor`).
 */
function threadModeConfig(mode: RuntimeMode, cwd: string): ThreadModeConfig {
  switch (mode) {
    case 'approval-required':
      return {
        approvalPolicy: null,
        approvalsReviewer: 'user',
        configArgs: ['-c', `projects={${tomlString(cwd)}={trust_level="untrusted"}}`],
      };
    case 'auto-accept-edits':
      return { approvalPolicy: 'on-request', approvalsReviewer: 'user', configArgs: [] };
    case 'auto':
      return { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', configArgs: [] };
    case 'full-access':
      return { approvalPolicy: 'never', approvalsReviewer: 'user', configArgs: [] };
  }
}

const SANDBOX_MODES = new Set<CodexSandboxMode>([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

/**
 * The `sandbox_mode` the session's Codex configuration names, passed with the
 * thread as well: a resumed thread otherwise keeps the sandbox it started
 * with, whatever the configuration says now. Null when it names none, so Codex
 * applies its own default.
 */
async function configuredSandbox(codexHome: string | undefined): Promise<CodexSandboxMode | null> {
  if (!codexHome) return null;
  let text: string;
  try {
    text = await readFile(join(codexHome, 'config.toml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const mode = parse(text).sandbox_mode;
  return typeof mode === 'string' && SANDBOX_MODES.has(mode as CodexSandboxMode)
    ? (mode as CodexSandboxMode)
    : null;
}

/**
 * The sandbox a thread runs in. Auto mode never runs unsandboxed: in
 * `danger-full-access` nothing asks for approval, so Codex's automatic review
 * would never see a request and auto would quietly be full access.
 */
function sandboxFor(
  mode: RuntimeMode,
  configured: CodexSandboxMode | null
): CodexSandboxMode | null {
  return mode === 'auto' && configured === 'danger-full-access' ? 'workspace-write' : configured;
}

function sessionStatusOf(status: CodexThreadStatusChangedNotification['status']): SessionStatus {
  switch (status.type) {
    case 'idle':
      return 'ready';
    case 'active':
      return 'running';
    case 'systemError':
      return 'error';
    default:
      return 'starting';
  }
}

function turnOutcomeOf(status: CodexTurnNotification['turn']['status']): TurnOutcome {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'error';
  }
}

/**
 * The card for Codex asking to run an MCP tool: the server and tool in the
 * title, the arguments as the detail. Codex names the tool only in its
 * message, so a message worded otherwise leaves the tool out of the title.
 */
function mcpToolCallContent(
  serverName: string,
  message: string,
  meta: CodexMcpToolCallMeta
): { title: string; detail?: string } {
  const tool = /run tool "([^"]+)"/.exec(message)?.[1];
  const title = tool ? `${serverName} wants to run ${tool}` : `${serverName} wants to run a tool`;
  const detail = (meta.tool_params_display ?? [])
    .map(({ name, display_name, value }) => {
      const shown = typeof value === 'string' ? value : JSON.stringify(value);
      return `${display_name ?? name}: ${shown}`;
    })
    .join('\n');
  return detail ? { title, detail } : { title };
}

function approvalOptions(decisions: ApprovalDecision[]): ApprovalOption[] {
  const labels: Record<ApprovalDecision, string> = {
    accept: 'Approve',
    acceptForSession: 'Approve for this session',
    decline: 'Decline',
    cancel: 'Cancel',
  };
  return decisions.map((decision) => ({ decision, label: labels[decision] }));
}

function advertisedDecisions(raw: CodexCommandExecutionApprovalParams): ApprovalDecision[] {
  const known: ApprovalDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];
  const advertised = (raw.availableDecisions ?? []).filter(
    (decision): decision is ApprovalDecision =>
      typeof decision === 'string' && known.includes(decision)
  );
  const decisions: ApprovalDecision[] = advertised.length > 0 ? [...advertised] : ['accept'];
  for (const fallback of ['decline', 'cancel'] as const) {
    if (!decisions.includes(fallback)) decisions.push(fallback);
  }
  return decisions;
}

/**
 * Which part of a command approval is the command and which is the prose.
 *
 * A reader sees `detail` set apart — a code span where the surface has one — so
 * the command belongs there and Codex's reason for asking belongs in the title.
 * With no command there is nothing to set apart and the prose carries the card.
 */
function commandApprovalContent(payload: CodexCommandExecutionApprovalParams): {
  title: string;
  detail?: string;
} {
  const where = payload.cwd ? `Run a command in ${payload.cwd}` : 'Run a command';
  if (!payload.command) return { title: payload.reason ?? where };
  return { title: payload.reason ?? where, detail: payload.command };
}

function toCodexInput(
  text: string,
  attachments: ProviderSendTurnInput['attachments']
): CodexUserInput[] {
  const input: CodexUserInput[] = [{ type: 'text', text, text_elements: [] }];
  for (const attachment of attachments ?? []) {
    if (attachment.mimeType.startsWith('image/')) {
      input.push({ type: 'localImage', path: attachment.path });
    } else {
      input.push({ type: 'mention', name: basename(attachment.path), path: attachment.path });
    }
  }
  return input;
}

export class CodexAdapter implements ProviderAdapter {
  readonly provider = PROVIDER;
  readonly capabilities: ProviderCapabilities = {
    modelSwitchInSession: true,
    steering: true,
    resume: true,
    approvals: true,
    userInput: false,
  };

  private readonly sessions = new Map<string, CodexSessionState>();
  private readonly listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly binaryPath: string;
  private readonly logger: ProviderLogger;
  private readonly features: Record<string, boolean>;
  private requestSeq = 0;

  constructor(options: CodexAdapterOptions = {}) {
    this.binaryPath = options.binaryPath ?? 'codex';
    this.logger = options.logger ?? noopLogger;
    this.features = { ...DEFAULT_FEATURES, ...options.features };
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    if (this.sessions.has(input.sessionId)) {
      throw new ProviderSessionError(PROVIDER, input.sessionId, 'session already started');
    }
    const mode = threadModeConfig(input.runtimeMode, input.cwd);
    const mcp = mcpServerConfigArgs(input.mcpServers, input.connectorMcpServers, input.runtimeMode);
    const args = ['app-server', ...featureArgs(this.features), ...mode.configArgs, ...mcp.args];
    const env = { ...input.env, ...mcp.env };
    const keyringLogin = input.codexKeyringLogin;
    let handOver = false;
    if (keyringLogin) {
      try {
        handOver = await this.lacksOwnLogin(args, input.cwd, env);
      } catch (cause) {
        throw new ProviderSessionError(
          PROVIDER,
          input.sessionId,
          `could not check the codex login: ${String(cause)}`,
          { cause }
        );
      }
      if (this.sessions.has(input.sessionId))
        throw new ProviderSessionError(PROVIDER, input.sessionId, 'session already started');
    }
    const client = new StdioJsonRpcClient({
      command: this.binaryPath,
      args: handOver ? [...args, ...EPHEMERAL_LOGIN_ARGS] : args,
      cwd: input.cwd,
      env,
      logger: this.logger,
      onExit: (reason) => this.handleProcessExit(input.sessionId, reason),
    });

    const state: CodexSessionState = {
      sessionId: input.sessionId,
      threadId: '',
      client,
      model: input.model?.id,
      effort: input.model?.options?.effort,
      unboundTurnIds: [],
      turnIdByNative: new Map(),
      approvals: new Map(),
      userInputs: new Map(),
      items: new Map(),
      deltaBuffers: new Map(),
      stopping: false,
      exited: false,
      usage: new CumulativeUsage(),
      unreportedUsage: [],
      connectorMcpServers: new Set(input.connectorMcpServers),
    };
    this.sessions.set(input.sessionId, state);
    this.registerHandlers(state);
    this.emit(state, { type: 'session.state.changed', status: 'starting' });

    let sandboxWarning: string | undefined;
    try {
      const initializeParams: CodexInitializeParams = {
        clientInfo: { name: CLIENT_NAME, title: 'Switch Console', version: CLIENT_VERSION },
        capabilities: { experimentalApi: true, requestAttestation: false },
      };
      await client.request(CODEX_CLIENT_METHODS.initialize, initializeParams);
      client.notify(CODEX_CLIENT_NOTIFICATIONS.initialized, null);
      const account = accountSchema.parse(
        await client.request('account/read', { refreshToken: false })
      );
      if (!account.account && account.requiresOpenaiAuth) {
        if (!keyringLogin || !handOver) throw new Error(CODEX_SIGN_IN_REQUIRED);
        await this.signInFromKeyring(client, input.cwd, keyringLogin);
      }

      const configured = await configuredSandbox(input.env.CODEX_HOME);
      const sandbox = sandboxFor(input.runtimeMode, configured);
      if (sandbox !== configured)
        sandboxWarning = `Auto mode runs Codex in the ${sandbox} sandbox instead of the configured ${configured}: unsandboxed, nothing would reach its automatic review.`;
      const config = {
        cwd: input.cwd,
        ...(mode.approvalPolicy ? { approvalPolicy: mode.approvalPolicy } : {}),
        ...(sandbox ? { sandbox } : {}),
        approvalsReviewer: mode.approvalsReviewer,
        ...(input.model?.id ? { model: input.model.id } : {}),
        ...(input.systemContext ? { developerInstructions: input.systemContext } : {}),
      };
      const opened = await this.openThread(client, config, input.resume?.nativeSessionId);
      state.threadId = opened.thread.id;
    } catch (cause) {
      // A start stopped part-way (reset while it waited on the keyring, say)
      // may already have been replaced under the same id.
      if (this.sessions.get(input.sessionId) === state) this.sessions.delete(input.sessionId);
      await client.dispose();
      if (
        input.resume &&
        cause instanceof JsonRpcError &&
        cause.code === -32600 &&
        cause.message.startsWith('no rollout found for thread id ')
      )
        throw new ProviderConversationUnavailableError(
          PROVIDER,
          input.sessionId,
          'The saved Codex conversation is unavailable. Start a fresh conversation to continue.',
          { cause }
        );
      throw new ProviderSessionError(
        PROVIDER,
        input.sessionId,
        `could not start a codex app-server thread: ${String(cause)}${
          client.stderr ? `\n${client.stderr}` : ''
        }`,
        { cause }
      );
    }

    this.emit(state, { type: 'session.started', nativeSessionId: state.threadId });
    if (sandboxWarning) {
      this.logger.warn(sandboxWarning, { sessionId: input.sessionId });
      this.emit(state, { type: 'runtime.warning', message: sandboxWarning });
    }
    this.emit(state, { type: 'session.state.changed', status: 'ready' });
    return { sessionId: input.sessionId, nativeSessionId: state.threadId, provider: PROVIDER };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    const state = this.requireSession(input.sessionId);
    if (input.model?.id) {
      state.model = input.model.id;
      state.effort = input.model.options?.effort;
    }
    const codexInput = toCodexInput(input.text, input.attachments);

    const active = state.activeNativeTurnId;
    if (active) {
      const steered = await this.trySteer(state, active, codexInput);
      if (steered) {
        return { turnId: input.turnId, steeredInto: state.turnIdByNative.get(steered) ?? steered };
      }
    }

    state.unboundTurnIds.push(input.turnId);
    try {
      const response = await state.client.request<CodexTurnStartResponse>(
        CODEX_CLIENT_METHODS.turnStart,
        {
          threadId: state.threadId,
          input: codexInput,
          ...(state.model ? { model: state.model } : {}),
          ...(state.effort ? { effort: state.effort } : {}),
        }
      );
      this.bindTurn(state, response.turn.id);
      return { turnId: input.turnId };
    } catch (cause) {
      const index = state.unboundTurnIds.indexOf(input.turnId);
      if (index >= 0) state.unboundTurnIds.splice(index, 1);
      throw new ProviderSessionError(
        PROVIDER,
        input.sessionId,
        `turn/start failed: ${String(cause)}`,
        {
          cause,
        }
      );
    }
  }

  async interruptTurn(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    const turnId = state.activeNativeTurnId;
    if (!turnId) return;
    const commandIds = new Set(
      [...state.items.values()]
        .filter((item) => item.type === 'commandExecution')
        .map((item) => item.id)
    );
    await state.client.request(CODEX_CLIENT_METHODS.turnInterrupt, {
      threadId: state.threadId,
      turnId,
    });
    // turn/interrupt stops generation, but unified exec commands can outlive it.
    if (commandIds.size > 0) {
      let cursor: string | null = null;
      do {
        const page: {
          data: Array<{ itemId: string; processId: string }>;
          nextCursor: string | null;
        } = await state.client.request(CODEX_CLIENT_METHODS.backgroundTerminalsList, {
          threadId: state.threadId,
          ...(cursor ? { cursor } : {}),
        });
        for (const terminal of page.data) {
          if (commandIds.has(terminal.itemId)) {
            await state.client.request(CODEX_CLIENT_METHODS.backgroundTerminalsTerminate, {
              threadId: state.threadId,
              processId: terminal.processId,
            });
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
  }

  async respondToRequest(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    const state = this.requireSession(sessionId);
    const pending = state.approvals.get(requestId);
    if (!pending) {
      throw new ProviderSessionError(PROVIDER, sessionId, `no open request ${requestId}`);
    }
    state.approvals.delete(requestId);
    pending.settle(decision);
    this.emit(state, { type: 'request.resolved', requestId, decision });
  }

  async respondToUserInput(
    sessionId: string,
    requestId: string,
    answers: UserInputAnswers
  ): Promise<void> {
    const state = this.requireSession(sessionId);
    const pending = state.userInputs.get(requestId);
    if (!pending) {
      throw new ProviderSessionError(PROVIDER, sessionId, `no open question ${requestId}`);
    }
    state.userInputs.delete(requestId);
    pending.settle(answers);
    this.emit(state, { type: 'user-input.resolved', requestId });
  }

  async addDeveloperMessage(sessionId: string, text: string): Promise<void> {
    const state = this.requireSession(sessionId);
    await state.client.request('thread/inject_items', {
      threadId: state.threadId,
      items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }],
    });
  }

  async contextUsage(
    sessionId: string
  ): Promise<{ usedTokens: number; windowTokens: number | null } | null> {
    return this.requireSession(sessionId).context ?? null;
  }

  async compactSession(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    if (state.activeNativeTurnId || state.compaction) throw new Error('SESSION_BUSY');
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    void promise.catch(() => {});
    const pending = { promise, resolve, reject };
    state.compaction = pending;
    state.context = undefined;
    try {
      await state.client.request('thread/compact/start', { threadId: state.threadId });
      await pending.promise;
    } finally {
      state.compaction = undefined;
    }
  }

  async listModels(sessionId: string) {
    const state = this.requireSession(sessionId);
    const models: { id: string; label: string; options: Record<string, string[]> }[] = [];
    let cursor: string | null = null;
    do {
      const page: {
        data: {
          model: string;
          displayName: string;
          supportedReasoningEfforts: { reasoningEffort: string }[];
        }[];
        nextCursor: string | null;
      } = await state.client.request('model/list', { cursor, limit: 100 });
      models.push(
        ...page.data.map((model) => ({
          id: model.model,
          label: model.displayName,
          options: {
            effort: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
          },
        }))
      );
      cursor = page.nextCursor;
    } while (cursor);
    return models;
  }

  async setModel(sessionId: string, model: ModelSelection): Promise<void> {
    const state = this.requireSession(sessionId);
    state.model = model.id;
    state.effort = model.options?.effort;
  }

  async stopSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.stopping = true;
    state.compaction?.reject(new Error('Native compaction was interrupted by session shutdown.'));
    this.cancelPending(state);
    // Let the cancel answers reach codex before stdin is closed under them.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await state.client.dispose();
    this.finishSession(state, 'stopped by Switch');
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.stopSession(sessionId)));
  }

  private async openThread(
    client: StdioJsonRpcClient,
    config: Record<string, unknown>,
    resumeThreadId: string | undefined
  ): Promise<CodexThreadOpenResponse> {
    if (!resumeThreadId) {
      return client.request<CodexThreadOpenResponse>(CODEX_CLIENT_METHODS.threadStart, config);
    }
    return client.request<CodexThreadOpenResponse>(CODEX_CLIENT_METHODS.threadResume, {
      ...config,
      threadId: resumeThreadId,
      excludeTurns: true,
    });
  }

  /**
   * Whether a session that could be handed a keyring login has no login of
   * its own, asked of its Codex as configured. A copy of the machine's old
   * auth.json, or a login Codex saved for the session itself, keeps working
   * and is left alone; a copy that no longer works is only a plaintext secret
   * then, and is removed. Only the account cached at startup is read, so this
   * refreshes nothing.
   */
  private async lacksOwnLogin(
    args: string[],
    cwd: string,
    env: Record<string, string>
  ): Promise<boolean> {
    const probe = new StdioJsonRpcClient({
      command: this.binaryPath,
      args,
      cwd,
      env,
      logger: noopLogger,
      onExit: () => {},
    });
    try {
      await probe.request(CODEX_CLIENT_METHODS.initialize, {
        clientInfo: { name: CLIENT_NAME, title: 'Switch Console', version: CLIENT_VERSION },
      });
      probe.notify(CODEX_CLIENT_NOTIFICATIONS.initialized, null);
      const account = accountSchema.parse(
        await probe.request('account/read', { refreshToken: false })
      );
      if (account.account || !account.requiresOpenaiAuth) return false;
    } catch (error) {
      throw new Error(`${String(error)}${probe.stderr ? `\n${probe.stderr}` : ''}`, {
        cause: error,
      });
    } finally {
      await probe.dispose().catch((error: unknown) =>
        this.logger.warn('The Codex that checked a session login did not stop.', {
          error: String(error),
        })
      );
    }
    if (env.CODEX_HOME) await rm(join(env.CODEX_HOME, 'auth.json'), { force: true });
    return true;
  }

  /**
   * Hands the session's Codex the API key the machine's Codex keeps in the OS
   * keyring. Codex saves a login where its configuration says, so the key is
   * sent only once this process confirms it keeps logins in memory: a managed
   * configuration or an administrator's requirements outrank the command line.
   */
  private async signInFromKeyring(
    client: StdioJsonRpcClient,
    cwd: string,
    login: CodexKeyringLogin
  ): Promise<void> {
    const { config } = z
      .object({ config: z.object({ cli_auth_credentials_store: z.unknown() }) })
      .parse(await client.request('config/read', { cwd }));
    const store = config.cli_auth_credentials_store;
    if (store !== 'ephemeral')
      throw new Error(
        `Codex's configuration on the execution machine sets cli_auth_credentials_store to ${JSON.stringify(store ?? null)} for this session where Switch asked for "ephemeral" (an administrator's managed configuration or requirements can do this), so Switch did not hand the session the API key from the OS keyring: Codex would have saved another copy of it.`
      );
    const apiKey = await readCodexKeyringApiKey(
      this.binaryPath,
      login,
      CODEX_KEYRING_READ_TIMEOUT_MS
    );
    if (apiKey === null) throw new Error(CODEX_KEYRING_SIGN_IN_REQUIRED);
    login.redact(apiKey);
    await client.request('account/login/start', { type: 'apiKey', apiKey });
    const { account } = accountSchema.parse(
      await client.request('account/read', { refreshToken: false })
    );
    if (!z.object({ type: z.literal('apiKey') }).safeParse(account).success)
      throw new Error('Codex did not take the API key handed over from the OS keyring.');
  }

  private async trySteer(
    state: CodexSessionState,
    activeTurnId: string,
    input: CodexUserInput[]
  ): Promise<string | null> {
    try {
      const response = await state.client.request<CodexTurnSteerResponse>(
        CODEX_CLIENT_METHODS.turnSteer,
        { threadId: state.threadId, input, expectedTurnId: activeTurnId }
      );
      return response.turnId;
    } catch (cause) {
      if (!(cause instanceof JsonRpcError)) throw cause;
      this.logger.warn('codex turn/steer refused; queueing a new turn instead', {
        sessionId: state.sessionId,
        error: cause.message,
      });
      this.emit(state, {
        type: 'runtime.warning',
        message: `Codex could not steer the running turn (${cause.message}); the message was queued as a new turn.`,
      });
      return null;
    }
  }

  private bindTurn(state: CodexSessionState, nativeTurnId: string): string | undefined {
    const existing = state.turnIdByNative.get(nativeTurnId);
    if (existing) return existing;
    const turnId = state.unboundTurnIds.shift();
    if (!turnId) return undefined;
    state.turnIdByNative.set(nativeTurnId, turnId);
    return turnId;
  }

  private registerHandlers(state: CodexSessionState): void {
    const client = state.client;

    client.onNotification(CODEX_SERVER_NOTIFICATIONS.threadStatusChanged, (params) => {
      const payload = params as CodexThreadStatusChangedNotification;
      if (!this.isOwnThread(state, payload.threadId)) return;
      this.emit(state, {
        type: 'session.state.changed',
        status: sessionStatusOf(payload.status),
        raw: { source: CODEX_SERVER_NOTIFICATIONS.threadStatusChanged, payload },
      });
    });

    client.onNotification(CODEX_SERVER_NOTIFICATIONS.threadTokenUsageUpdated, (params) => {
      const payload = params as CodexThreadTokenUsageUpdatedNotification;
      if (!this.isOwnThread(state, payload.threadId)) return;
      const { total, last } = payload.tokenUsage;
      // The compaction call's own report measures the history it replaced.
      if (!state.compaction)
        state.context = {
          usedTokens: last.totalTokens,
          windowTokens: payload.tokenUsage.modelContextWindow,
        };
      if (!state.usage.started) {
        state.usage.startFrom(
          new Map([['', subtractCodexUsage(codexCounts(total), codexCounts(last))]])
        );
      }
      const spent = state.usage.advance(new Map([['', codexCounts(total)]]));
      const model = state.model ?? '';
      state.unreportedUsage = mergeUsage(
        state.unreportedUsage,
        spent.map((entry) => ({ ...entry, model }))
      );
    });

    client.onNotification(CODEX_SERVER_NOTIFICATIONS.turnStarted, (params) => {
      const payload = params as CodexTurnNotification;
      if (!this.isOwnThread(state, payload.threadId)) return;
      state.activeNativeTurnId = payload.turn.id;
      const turnId = this.bindTurn(state, payload.turn.id);
      if (!turnId) return;
      this.emit(state, {
        type: 'turn.started',
        turnId,
        raw: { source: CODEX_SERVER_NOTIFICATIONS.turnStarted, payload },
      });
    });

    client.onNotification(CODEX_SERVER_NOTIFICATIONS.turnCompleted, (params) => {
      const payload = params as CodexTurnNotification;
      if (!this.isOwnThread(state, payload.threadId)) return;
      if (state.activeNativeTurnId === payload.turn.id) state.activeNativeTurnId = undefined;
      if (state.compaction) {
        if (payload.turn.status === 'completed') state.compaction.resolve();
        else
          state.compaction.reject(
            new Error(payload.turn.error?.message ?? 'Native compaction was interrupted.')
          );
        return;
      }
      const turnId = state.turnIdByNative.get(payload.turn.id);
      state.turnIdByNative.delete(payload.turn.id);
      const outcome = turnOutcomeOf(payload.turn.status);
      const message =
        payload.turn.error?.message ?? (outcome === 'interrupted' ? 'Interrupted.' : undefined);
      if (turnId && outcome !== 'completed') {
        for (const item of state.items.values()) {
          const mapped = mapCodexItem(item, 'started');
          this.emit(state, {
            type: 'item.completed',
            turnId,
            item: {
              ...mapped,
              status: 'failed',
              text: [state.deltaBuffers.get(item.id) ?? mapped.text, message ?? 'Turn failed.']
                .filter(Boolean)
                .join('\n'),
            },
          });
        }
        this.cancelPending(state);
      }
      state.items.clear();
      state.deltaBuffers.clear();
      if (!turnId) return;
      this.emit(state, {
        type: 'turn.completed',
        turnId,
        outcome,
        ...(message ? { message } : {}),
        usage: this.takeUsage(state),
        raw: { source: CODEX_SERVER_NOTIFICATIONS.turnCompleted, payload },
      });
    });

    client.onNotification(CODEX_SERVER_NOTIFICATIONS.itemStarted, (params) => {
      const payload = params as CodexItemNotification;
      if (!this.isOwnThread(state, payload.threadId)) return;
      state.items.set(payload.item.id, payload.item);
      const turnId = this.turnIdFor(state, payload.turnId);
      if (!turnId) return;
      this.emit(state, {
        type: 'item.started',
        turnId,
        item: mapCodexItem(payload.item, 'started'),
        raw: { source: CODEX_SERVER_NOTIFICATIONS.itemStarted, payload },
      });
    });

    client.onNotification(CODEX_SERVER_NOTIFICATIONS.itemCompleted, (params) => {
      const payload = params as CodexItemNotification;
      if (!this.isOwnThread(state, payload.threadId)) return;
      state.items.delete(payload.item.id);
      state.deltaBuffers.delete(payload.item.id);
      const turnId = this.turnIdFor(state, payload.turnId);
      if (!turnId) return;
      this.emit(state, {
        type: 'item.completed',
        turnId,
        item: mapCodexItem(payload.item, 'completed'),
        raw: { source: CODEX_SERVER_NOTIFICATIONS.itemCompleted, payload },
      });
    });

    client.onNotification(CODEX_SERVER_NOTIFICATIONS.agentMessageDelta, (params) => {
      const payload = params as CodexDeltaNotification;
      if (!this.isOwnThread(state, payload.threadId)) return;
      const turnId = this.turnIdFor(state, payload.turnId);
      if (!turnId) return;
      this.emit(state, {
        type: 'content.delta',
        turnId,
        itemId: payload.itemId,
        delta: payload.delta,
      });
    });

    for (const method of [
      CODEX_SERVER_NOTIFICATIONS.commandExecutionOutputDelta,
      CODEX_SERVER_NOTIFICATIONS.reasoningTextDelta,
      CODEX_SERVER_NOTIFICATIONS.reasoningSummaryTextDelta,
    ]) {
      client.onNotification(method, (params) => {
        this.handleItemTextDelta(state, params as CodexDeltaNotification, method);
      });
    }

    client.onNotification(CODEX_SERVER_NOTIFICATIONS.error, (params) => {
      const payload = params as CodexErrorNotification;
      if (!this.isOwnThread(state, payload.threadId)) return;
      const turnId = this.turnIdFor(state, payload.turnId);
      this.emit(state, {
        type: 'runtime.error',
        message: payload.error.message,
        ...(turnId ? { turnId } : {}),
        raw: { source: CODEX_SERVER_NOTIFICATIONS.error, payload },
      });
    });

    client.onServerRequest(CODEX_SERVER_REQUESTS.commandExecutionApproval, (params) => {
      const payload = params as CodexCommandExecutionApprovalParams;
      return this.openApproval(state, {
        turnId: payload.turnId,
        requestType: 'command_execution_approval',
        ...commandApprovalContent(payload),
        options: approvalOptions(advertisedDecisions(payload)),
        respond: (decision) => ({ decision }),
      });
    });

    client.onServerRequest(CODEX_SERVER_REQUESTS.fileChangeApproval, (params) => {
      const payload = params as CodexFileChangeApprovalParams;
      return this.openApproval(state, {
        turnId: payload.turnId,
        requestType: 'file_change_approval',
        title: 'Apply file changes',
        detail: payload.reason ?? payload.grantRoot ?? undefined,
        options: approvalOptions(['accept', 'acceptForSession', 'decline', 'cancel']),
        respond: (decision) => ({ decision }),
      });
    });

    client.onServerRequest(CODEX_SERVER_REQUESTS.permissionsApproval, (params) => {
      const payload = params as CodexPermissionsApprovalParams;
      return this.openApproval(state, {
        turnId: payload.turnId,
        requestType: 'tool_approval',
        title: 'Grant additional permissions',
        detail: payload.reason ?? payload.cwd,
        options: approvalOptions(['accept', 'acceptForSession', 'decline', 'cancel']),
        respond: (decision) => {
          const granted = decision === 'accept' || decision === 'acceptForSession';
          return {
            permissions: granted
              ? {
                  ...(payload.permissions.network ? { network: payload.permissions.network } : {}),
                  ...(payload.permissions.fileSystem
                    ? { fileSystem: payload.permissions.fileSystem }
                    : {}),
                }
              : {},
            scope: decision === 'acceptForSession' ? 'session' : 'turn',
          };
        },
      });
    });

    client.onServerRequest(CODEX_SERVER_REQUESTS.mcpElicitation, (params) => {
      const payload = params as CodexMcpElicitationParams;
      const toolCall =
        payload._meta?.codex_approval_kind === 'mcp_tool_call' ? payload._meta : null;
      // Codex keeps an approval for the thread only when the answer says so
      // in `_meta`; the same `persist` inside `content` does nothing.
      const forSession = toolCall?.persist?.includes('session') ?? false;
      return this.openApproval(state, {
        turnId: payload.turnId ?? state.activeNativeTurnId ?? '',
        requestType: 'mcp_tool_approval',
        ...(toolCall
          ? mcpToolCallContent(payload.serverName, payload.message, toolCall)
          : { title: `${payload.serverName} needs a decision`, detail: payload.message }),
        options: approvalOptions(
          forSession
            ? ['accept', 'acceptForSession', 'decline', 'cancel']
            : ['accept', 'decline', 'cancel']
        ),
        ...(state.connectorMcpServers.has(payload.serverName)
          ? { connector: payload.serverName }
          : {}),
        respond: (decision) => ({
          action: decision === 'decline' ? 'decline' : decision === 'cancel' ? 'cancel' : 'accept',
          content: decision === 'accept' || decision === 'acceptForSession' ? {} : null,
          _meta: decision === 'acceptForSession' ? { persist: 'session' } : null,
        }),
      });
    });

    client.onServerRequest(CODEX_SERVER_REQUESTS.toolRequestUserInput, (params) =>
      this.openUserInput(state, params as CodexToolRequestUserInputParams)
    );
  }

  private handleItemTextDelta(
    state: CodexSessionState,
    payload: CodexDeltaNotification,
    source: string
  ): void {
    if (!this.isOwnThread(state, payload.threadId)) return;
    const buffered = `${state.deltaBuffers.get(payload.itemId) ?? ''}${payload.delta}`;
    state.deltaBuffers.set(payload.itemId, buffered);
    const cached = state.items.get(payload.itemId);
    const turnId = this.turnIdFor(state, payload.turnId);
    if (!cached || !turnId) return;
    this.emit(state, {
      type: 'item.delta',
      turnId,
      itemId: payload.itemId,
      delta: payload.delta,
      raw: { source, payload },
    });
  }

  private openApproval(
    state: CodexSessionState,
    spec: {
      turnId: string;
      requestType: RequestType;
      title: string;
      detail?: string;
      options: ApprovalOption[];
      connector?: string;
      respond: (decision: ApprovalDecision) => unknown;
    }
  ): Promise<unknown> {
    const requestId = `codex-req-${++this.requestSeq}-${randomUUID().slice(0, 8)}`;
    const turnId = this.turnIdFor(state, spec.turnId) ?? spec.turnId;
    return new Promise<unknown>((resolve) => {
      state.approvals.set(requestId, { settle: (decision) => resolve(spec.respond(decision)) });
      this.emit(state, {
        type: 'request.opened',
        turnId,
        requestId,
        requestType: spec.requestType,
        title: spec.title,
        ...(spec.detail ? { detail: spec.detail } : {}),
        options: spec.options,
        ...(spec.connector ? { connector: spec.connector } : {}),
      });
    });
  }

  private openUserInput(
    state: CodexSessionState,
    payload: CodexToolRequestUserInputParams
  ): Promise<unknown> {
    const requestId = `codex-ask-${++this.requestSeq}-${randomUUID().slice(0, 8)}`;
    const turnId = this.turnIdFor(state, payload.turnId) ?? payload.turnId;
    const questions: UserInputQuestion[] = payload.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: (question.options ?? []).map((option) => ({
        label: option.label,
        description: option.description,
        value: option.label,
      })),
      multiSelect: false,
      allowCustomAnswer: question.isOther,
    }));
    return new Promise<unknown>((resolve) => {
      state.userInputs.set(requestId, {
        settle: (answers) => {
          const encoded: Record<string, { answers: string[] }> = {};
          for (const question of questions) {
            const answer = answers[question.id];
            if (answer === undefined) continue;
            encoded[question.id] = { answers: Array.isArray(answer) ? answer : [answer] };
          }
          resolve({ answers: encoded });
        },
      });
      this.emit(state, { type: 'user-input.requested', turnId, requestId, questions });
    });
  }

  /**
   * A subagent runs as its own thread on the same app-server process, so every
   * notification has to be matched against this session's thread before it is
   * allowed to move turn state.
   */
  private isOwnThread(state: CodexSessionState, threadId: string): boolean {
    return state.threadId === '' || state.threadId === threadId;
  }

  /** Lookup only: binding happens on `turn/start` and on `turn/started`. */
  private turnIdFor(state: CodexSessionState, nativeTurnId: string): string | undefined {
    return state.turnIdByNative.get(nativeTurnId);
  }

  private cancelPending(state: CodexSessionState): void {
    for (const [requestId, pending] of [...state.approvals]) {
      state.approvals.delete(requestId);
      pending.settle('cancel');
      this.emit(state, { type: 'request.resolved', requestId, decision: 'cancel' });
    }
    for (const [requestId, pending] of [...state.userInputs]) {
      state.userInputs.delete(requestId);
      pending.settle({});
      this.emit(state, { type: 'user-input.resolved', requestId });
    }
  }

  private handleProcessExit(sessionId: string, reason: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.cancelPending(state);
    this.finishSession(state, reason);
  }

  private takeUsage(state: CodexSessionState): TokenUsage[] {
    const usage = state.unreportedUsage;
    state.unreportedUsage = [];
    return usage;
  }

  private finishSession(state: CodexSessionState, reason: string): void {
    state.compaction?.reject(new Error(reason));
    if (state.exited) return;
    state.exited = true;
    this.sessions.delete(state.sessionId);
    for (const [nativeTurnId, turnId] of state.turnIdByNative) {
      state.turnIdByNative.delete(nativeTurnId);
      this.emit(state, {
        type: 'turn.completed',
        turnId,
        outcome: state.stopping ? 'interrupted' : 'error',
        message: reason,
        usage: this.takeUsage(state),
      });
    }
    this.emit(state, { type: 'session.state.changed', status: 'stopped' });
    this.emit(state, { type: 'session.exited', reason });
  }

  private requireSession(sessionId: string): CodexSessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new ProviderSessionError(PROVIDER, sessionId, 'unknown or stopped session');
    if (!state.client.isAlive) {
      throw new ProviderSessionError(PROVIDER, sessionId, 'codex app-server is no longer running');
    }
    return state;
  }

  private emit(state: CodexSessionState, event: EmittableEvent): void {
    const full = {
      eventId: randomUUID(),
      provider: PROVIDER,
      sessionId: state.sessionId,
      createdAt: new Date().toISOString(),
      ...event,
    } as ProviderRuntimeEvent;
    for (const listener of [...this.listeners]) {
      try {
        listener(full);
      } catch (cause) {
        this.logger.error('codex event listener threw', { error: String(cause) });
      }
    }
  }
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): CodexAdapter {
  return new CodexAdapter(options);
}

function codexCounts(breakdown: CodexTokenUsageBreakdown): UsageCounts {
  return {
    inputTokens: breakdown.inputTokens - breakdown.cachedInputTokens,
    outputTokens: breakdown.outputTokens,
    cacheReadTokens: breakdown.cachedInputTokens,
    cacheWriteTokens: breakdown.cacheWriteInputTokens ?? 0,
  };
}

function subtractCodexUsage(total: UsageCounts, last: UsageCounts): UsageCounts {
  return {
    inputTokens: Math.max(0, total.inputTokens - last.inputTokens),
    outputTokens: Math.max(0, total.outputTokens - last.outputTokens),
    cacheReadTokens: Math.max(0, total.cacheReadTokens - last.cacheReadTokens),
    cacheWriteTokens: Math.max(0, total.cacheWriteTokens - last.cacheWriteTokens),
  };
}
