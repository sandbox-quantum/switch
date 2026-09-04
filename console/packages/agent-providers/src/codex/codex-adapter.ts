import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  type ModelSelection,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderSendTurnInput,
  type ProviderSession,
  ProviderSessionError,
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
  TurnOutcome,
  UserInputAnswers,
  UserInputQuestion,
} from '../events';
import {
  AppServerClient,
  JsonRpcError,
  noopLogger,
  type ProviderLogger,
} from './app-server-client';
import { featureArgs, mcpServerConfigArgs } from './config-args';
import { mapCodexItem } from './item-mapping';
import {
  CODEX_CLIENT_METHODS,
  CODEX_CLIENT_NOTIFICATIONS,
  CODEX_SERVER_NOTIFICATIONS,
  CODEX_SERVER_REQUESTS,
  type CodexAskForApproval,
  type CodexCommandExecutionApprovalParams,
  type CodexDeltaNotification,
  type CodexErrorNotification,
  type CodexFileChangeApprovalParams,
  type CodexInitializeParams,
  type CodexItemNotification,
  type CodexMcpElicitationParams,
  type CodexPermissionsApprovalParams,
  type CodexSandboxMode,
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

/**
 * `multi_agent_v2` ships stable but off, and it is what puts `spawn_agent` in
 * the model's tool set — without it a delegation request is answered inline and
 * no subagent item ever reaches the transcript.
 */
const DEFAULT_FEATURES: Record<string, boolean> = { multi_agent_v2: true };

const RESUME_FALLBACK_SNIPPETS = [
  'no rollout found',
  'not found',
  'no such thread',
  'unknown thread',
  'does not exist',
];

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
  client: AppServerClient;
  model?: string;
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
}

interface ThreadModeConfig {
  approvalPolicy: CodexAskForApproval;
  sandbox: CodexSandboxMode;
}

function threadModeConfig(mode: RuntimeMode): ThreadModeConfig {
  switch (mode) {
    case 'approval-required':
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
    case 'auto-accept-edits':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    case 'full-access':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
  }
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

function isResumeFallbackError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return RESUME_FALLBACK_SNIPPETS.some((snippet) => message.includes(snippet));
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
    userInput: true,
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
    const args = [
      'app-server',
      ...featureArgs(this.features),
      ...mcpServerConfigArgs(input.mcpServers),
    ];
    const client = new AppServerClient({
      command: this.binaryPath,
      args,
      cwd: input.cwd,
      env: input.env,
      logger: this.logger,
      onExit: (reason) => this.handleProcessExit(input.sessionId, reason),
    });

    const state: CodexSessionState = {
      sessionId: input.sessionId,
      threadId: '',
      client,
      model: input.model?.id,
      unboundTurnIds: [],
      turnIdByNative: new Map(),
      approvals: new Map(),
      userInputs: new Map(),
      items: new Map(),
      deltaBuffers: new Map(),
      stopping: false,
      exited: false,
    };
    this.sessions.set(input.sessionId, state);
    this.registerHandlers(state);
    this.emit(state, { type: 'session.state.changed', status: 'starting' });

    try {
      const initializeParams: CodexInitializeParams = {
        clientInfo: { name: CLIENT_NAME, title: 'Switch Console', version: CLIENT_VERSION },
        capabilities: { experimentalApi: true, requestAttestation: false },
      };
      await client.request(CODEX_CLIENT_METHODS.initialize, initializeParams);
      client.notify(CODEX_CLIENT_NOTIFICATIONS.initialized, null);

      const mode = threadModeConfig(input.runtimeMode);
      const config = {
        cwd: input.cwd,
        approvalPolicy: mode.approvalPolicy,
        sandbox: mode.sandbox,
        approvalsReviewer: 'user' as const,
        ...(input.model?.id ? { model: input.model.id } : {}),
        ...(input.systemContext ? { developerInstructions: input.systemContext } : {}),
      };
      const opened = await this.openThread(client, config, input.resume?.nativeSessionId);
      state.threadId = opened.thread.id;
    } catch (cause) {
      this.sessions.delete(input.sessionId);
      client.dispose();
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
    this.emit(state, { type: 'session.state.changed', status: 'ready' });
    return { sessionId: input.sessionId, nativeSessionId: state.threadId, provider: PROVIDER };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    const state = this.requireSession(input.sessionId);
    if (input.model?.id) state.model = input.model.id;
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
    await state.client.request(CODEX_CLIENT_METHODS.turnInterrupt, {
      threadId: state.threadId,
      turnId,
    });
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

  async setModel(sessionId: string, model: ModelSelection): Promise<void> {
    const state = this.requireSession(sessionId);
    state.model = model.id;
  }

  async stopSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.stopping = true;
    this.cancelPending(state);
    // Let the cancel answers reach codex before stdin is closed under them.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    state.client.dispose();
    this.finishSession(state, 'stopped by Switch');
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.stopSession(sessionId)));
  }

  private async openThread(
    client: AppServerClient,
    config: Record<string, unknown>,
    resumeThreadId: string | undefined
  ): Promise<CodexThreadOpenResponse> {
    if (!resumeThreadId) {
      return client.request<CodexThreadOpenResponse>(CODEX_CLIENT_METHODS.threadStart, config);
    }
    try {
      return await client.request<CodexThreadOpenResponse>(CODEX_CLIENT_METHODS.threadResume, {
        ...config,
        threadId: resumeThreadId,
        excludeTurns: true,
      });
    } catch (cause) {
      if (!isResumeFallbackError(cause)) throw cause;
      this.logger.warn('codex thread/resume failed; starting a fresh thread', {
        resumeThreadId,
        error: String(cause),
      });
      return client.request<CodexThreadOpenResponse>(CODEX_CLIENT_METHODS.threadStart, config);
    }
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
      const turnId = state.turnIdByNative.get(payload.turn.id);
      state.turnIdByNative.delete(payload.turn.id);
      state.items.clear();
      state.deltaBuffers.clear();
      if (!turnId) return;
      this.emit(state, {
        type: 'turn.completed',
        turnId,
        outcome: turnOutcomeOf(payload.turn.status),
        ...(payload.turn.error?.message ? { message: payload.turn.error.message } : {}),
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
      state.items.set(payload.item.id, payload.item);
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
        title: payload.command ?? 'Run a command',
        detail: payload.reason ?? payload.cwd ?? undefined,
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
      return this.openApproval(state, {
        turnId: payload.turnId ?? state.activeNativeTurnId ?? '',
        requestType: 'mcp_tool_approval',
        title: `${payload.serverName} needs a decision`,
        detail: payload.message,
        options: approvalOptions(['accept', 'decline', 'cancel']),
        respond: (decision) => ({
          action: decision === 'decline' ? 'decline' : decision === 'cancel' ? 'cancel' : 'accept',
          content: decision === 'accept' || decision === 'acceptForSession' ? {} : null,
          _meta: null,
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

  private finishSession(state: CodexSessionState, reason: string): void {
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
