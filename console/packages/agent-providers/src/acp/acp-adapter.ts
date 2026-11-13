import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelChoice } from '@switch-console/shared/session-v1';
import type {
  ModelSelection,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '../adapter';
import { ProviderConversationUnavailableError, ProviderSessionError } from '../adapter';
import type {
  ApprovalDecision,
  ProviderItem,
  ProviderRuntimeEvent,
  UserInputAnswers,
  UserInputQuestion,
} from '../events';
import {
  loginCommandOf,
  readiness,
  SIGNED_OUT_ERROR,
  signInWith,
  type ProviderReadiness,
  type SignInCheckInput,
} from '../readiness';
import {
  JsonRpcError,
  noopLogger,
  StdioJsonRpcClient,
  type ProviderLogger,
} from '../transport/stdio-json-rpc';
import type {
  AcpAdapterOptions,
  AcpProviderHooks,
  AcpSelectedAnswer,
  AcpSessionContext,
} from './hooks';
import { acpMcpServers, requireHttpMcp } from './mcp';
import {
  ACP_CANCELLED,
  modelConfigOption,
  modelsFromConfig,
  modelsFromList,
  type AcpConfigOption,
  type AcpInitializeResult,
  type AcpPermissionRequest,
  type AcpPromptCapabilities,
  type AcpSessionResult,
  type AcpSessionUpdate,
  type AcpToolCall,
} from './protocol';

export const ACP_CLIENT_INFO = { name: 'switch-console', version: '0.1.0' } as const;

/** The `initialize` request every ACP session and sign-in check opens with. */
export async function acpInitialize(
  client: StdioJsonRpcClient,
  hooks: Pick<AcpProviderHooks, 'clientCapabilities'>
): Promise<AcpInitializeResult> {
  return await client.request<AcpInitializeResult>('initialize', {
    protocolVersion: 1,
    clientInfo: ACP_CLIENT_INFO,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      ...hooks.clientCapabilities,
    },
  });
}

/** A provider's sign-in check, run the way its hooks say, always tidying up the process. */
export async function checkAcpSignIn(
  hooks: AcpProviderHooks,
  input: SignInCheckInput
): Promise<ProviderReadiness> {
  let client: StdioJsonRpcClient | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  const handshake = async () => {
    const { cleanup: tidy, ...launch } = await hooks.launch(input);
    cleanup = tidy;
    client = new StdioJsonRpcClient({
      ...launch,
      cwd: input.cwd,
      logger: noopLogger,
      onExit: () => {},
    });
    return await acpInitialize(client, hooks);
  };
  const request = async <T>(method: string, params: unknown): Promise<T> => {
    if (!client) throw new Error(`${hooks.label} was asked ${method} before its handshake.`);
    return await client.request<T>(method, params);
  };
  const connection = () => {
    if (!client)
      throw new Error(
        `${hooks.label}'s sign-in check asked for the agent's connection before its handshake opened one.`
      );
    return client;
  };
  try {
    if (hooks.checkSignIn)
      return await hooks.checkSignIn({ ...input, handshake, request, connection });
    await handshake();
    return readiness(
      'unknown',
      `${hooks.label} started but has no sign-in check. If its sessions fail, sign in on the execution machine with ${loginCommandOf(hooks, input.binaryPath)}.`
    );
  } finally {
    await client?.dispose();
    try {
      await cleanup?.();
    } catch {
      // The check's answer stands; a failed removal must not replace it.
    }
  }
}

interface PendingDecision {
  responses: Map<ApprovalDecision, unknown>;
  settle: (value: unknown) => void;
}
interface PendingQuestion {
  questions: UserInputQuestion[];
  answer: (selected: AcpSelectedAnswer[]) => unknown;
  settle: (value: unknown) => void;
}
interface State {
  id: string;
  nativeId: string;
  client: StdioJsonRpcClient;
  turn: string | null;
  queue: ProviderSendTurnInput[];
  items: Map<string, ProviderItem>;
  decisions: Map<string, PendingDecision>;
  questions: Map<string, PendingQuestion>;
  messageId: string;
  messageText: string;
  stopping: boolean;
  interrupted: boolean;
  /** Whether someone cancelled or declined one of this turn's approval requests. */
  refusedRequest: boolean;
  /** A tool call was declined this turn (`AcpProviderHooks.declineEndsTurn`). */
  declined: boolean;
  context: string;
  runtimeMode: ProviderSessionStartInput['runtimeMode'];
  mcpNames: Set<string>;
  /** The registered servers whose tools are allowed without asking: all but the connectors. */
  autoApprovedMcpNames: Set<string>;
  /**
   * The latest announcement or update of each tool call this turn that
   * `mcpServerOf` placed on a server, by id.
   */
  mcpToolCalls: Map<string, AcpToolCall>;
  prompt: AcpPromptCapabilities;
  configOptions: AcpConfigOption[];
  models: ModelChoice[];
  /** What the provider's `launch` prepared for this process, removed once it exits. */
  cleanup: (() => Promise<void>) | undefined;
  /** The removal of what `launch` prepared, once it has begun. */
  tidied: Promise<void> | undefined;
}

type Emittable<T = ProviderRuntimeEvent> = T extends ProviderRuntimeEvent
  ? Omit<T, 'eventId' | 'provider' | 'sessionId' | 'createdAt'>
  : never;

/**
 * One adapter for every agent that speaks the Agent Client Protocol. The
 * protocol is handled here, choosing behaviour from what the agent advertises
 * (`session/load` or `session/resume`, a models list or a `model` config
 * option); what differs between CLIs comes from {@link AcpProviderHooks}.
 */
export class AcpAdapter implements ProviderAdapter {
  readonly provider: string;
  readonly capabilities: ProviderCapabilities;
  private readonly sessions = new Map<string, State>();
  private readonly listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly logger: ProviderLogger;

  constructor(
    private readonly hooks: AcpProviderHooks,
    private readonly options: AcpAdapterOptions
  ) {
    this.provider = hooks.provider;
    this.capabilities = hooks.capabilities;
    this.logger = options.logger ?? noopLogger;
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  async startSession(input: ProviderSessionStartInput) {
    const { hooks } = this;
    if (this.hasSession(input.sessionId))
      throw new ProviderSessionError(hooks.provider, input.sessionId, 'session already started');
    const cwd = await realpath(input.cwd);
    const prefix = hooks.nativeSessionIdPrefix;
    if (input.resume && prefix && !input.resume.nativeSessionId.startsWith(prefix.prefix))
      throw new ProviderConversationUnavailableError(
        hooks.provider,
        input.sessionId,
        prefix.legacyMessage
      );
    const binaryPath = this.options.binaryPath ?? hooks.defaultBinary;
    const { cleanup, ...launch } = await hooks.launch({
      binaryPath,
      cwd,
      env: input.env,
      runtimeMode: input.runtimeMode,
      mcpServers: input.mcpServers,
    });
    const client = new StdioJsonRpcClient({
      ...launch,
      cwd,
      logger: this.logger,
      onExit: (reason) => this.exited(input.sessionId, reason),
    });
    const state: State = {
      id: input.sessionId,
      nativeId: '',
      client,
      turn: null,
      queue: [],
      items: new Map(),
      decisions: new Map(),
      questions: new Map(),
      messageId: '',
      messageText: '',
      stopping: false,
      interrupted: false,
      refusedRequest: false,
      declined: false,
      context: input.systemContext ?? '',
      runtimeMode: input.runtimeMode,
      mcpNames: new Set(Object.keys(input.mcpServers)),
      autoApprovedMcpNames: new Set(
        Object.keys(input.mcpServers).filter((name) => !input.connectorMcpServers.includes(name))
      ),
      mcpToolCalls: new Map(),
      prompt: {},
      configOptions: [],
      models: [],
      cleanup,
      tidied: undefined,
    };
    this.sessions.set(state.id, state);
    const context = this.context(state);
    client.onNotification('session/update', (params) => {
      const payload = params as { sessionId: string; update: AcpSessionUpdate };
      if (payload.sessionId === state.nativeId) this.update(state, payload.update);
    });
    client.onServerRequest('session/request_permission', (params) =>
      this.permission(state, context, params as AcpPermissionRequest)
    );
    hooks.extensions?.(context, {
      request: (method, handler) => client.onServerRequest(method, async (p) => handler(p)),
      notification: (method, handler) => client.onNotification(method, handler),
    });
    this.emit(state, { type: 'session.state.changed', status: 'starting' });
    try {
      const initialized = await acpInitialize(client, hooks);
      const agent = initialized.agentCapabilities ?? {};
      if (!hooks.mcpServersAtLaunch)
        requireHttpMcp(
          hooks.label,
          input.mcpServers,
          agent.mcpCapabilities?.http || hooks.mcpCapabilities?.http
        );
      state.prompt = {
        image: Boolean(agent.promptCapabilities?.image || hooks.promptCapabilities?.image),
        audio: Boolean(agent.promptCapabilities?.audio || hooks.promptCapabilities?.audio),
        embeddedContext: Boolean(
          agent.promptCapabilities?.embeddedContext || hooks.promptCapabilities?.embeddedContext
        ),
      };
      // Signing in belongs here: starting a session is work the user asked
      // for, so a browser opening is an answer to something they did. Sign-in
      // checks stop at the handshake above.
      const authMethodId = hooks.authMethodId?.(input.env, binaryPath);
      if (
        authMethodId &&
        !(await hooks.alreadySignedIn?.({
          binaryPath,
          env: input.env,
          request: <T>(method: string, params: unknown) => client.request<T>(method, params),
        }))
      )
        await client.request('authenticate', { methodId: authMethodId });
      const mcpServers = hooks.mcpServersAtLaunch ? [] : acpMcpServers(input.mcpServers, input.env);
      let method = 'session/new';
      if (input.resume) {
        method = agent.loadSession
          ? 'session/load'
          : agent.sessionCapabilities?.resume
            ? 'session/resume'
            : '';
        if (!method)
          throw new ProviderConversationUnavailableError(
            hooks.provider,
            input.sessionId,
            `This ${hooks.label} cannot resume saved conversations.`
          );
        state.nativeId = input.resume.nativeSessionId.slice(prefix?.prefix.length ?? 0);
      }
      const result = await client.request<AcpSessionResult>(method, {
        cwd,
        mcpServers,
        ...(input.resume ? { sessionId: state.nativeId } : {}),
      });
      state.nativeId = result.sessionId ?? state.nativeId;
      if (!state.nativeId) throw new Error(`${hooks.label} returned no session ID.`);
      state.configOptions = result.configOptions ?? [];
      state.models = modelConfigOption(state.configOptions)
        ? modelsFromConfig(state.configOptions)
        : modelsFromList(result.models);
      const mode = hooks.sessionMode?.(input.runtimeMode, result.modes);
      if (mode)
        await client.request('session/set_mode', { sessionId: state.nativeId, modeId: mode });
      const configured = hooks.sessionConfigOptions?.(input.runtimeMode, state.configOptions) ?? {};
      for (const [configId, value] of Object.entries(configured))
        await this.setConfigOption(state, configId, value);
      if (input.model) await this.setModel(state.id, input.model);
      const nativeSessionId = `${prefix?.prefix ?? ''}${state.nativeId}`;
      this.emit(state, { type: 'session.started', nativeSessionId });
      this.emit(state, { type: 'session.state.changed', status: 'ready' });
      return { provider: hooks.provider, sessionId: state.id, nativeSessionId };
    } catch (cause) {
      await client.dispose();
      this.sessions.delete(state.id);
      await this.tidy(state);
      if (cause instanceof ProviderConversationUnavailableError) throw cause;
      const details =
        cause instanceof JsonRpcError &&
        typeof cause.data === 'object' &&
        cause.data !== null &&
        'details' in cause.data
          ? String(cause.data.details)
          : '';
      const signIn =
        cause instanceof JsonRpcError &&
        cause.code === -32000 &&
        SIGNED_OUT_ERROR.test(cause.message)
          ? `. ${signInWith(loginCommandOf(hooks, binaryPath))}`
          : '';
      throw new ProviderSessionError(
        hooks.provider,
        state.id,
        `Could not start ${hooks.label}: ${String(cause)}${details ? `: ${details}` : ''}${signIn}${client.stderr ? `\n${client.stderr}` : ''}`,
        { cause }
      );
    }
  }

  async sendTurn(input: ProviderSendTurnInput) {
    const state = this.require(input.sessionId);
    state.queue.push(input);
    if (!state.turn) this.drain(state);
    return { turnId: input.turnId };
  }

  private drain(state: State): void {
    if (state.turn || state.stopping || !this.hasSession(state.id)) return;
    const input = state.queue.shift();
    if (!input) return;
    state.turn = input.turnId;
    state.interrupted = false;
    state.refusedRequest = false;
    state.declined = false;
    state.messageId = randomUUID();
    state.items.clear();
    state.mcpToolCalls.clear();
    this.emit(state, { type: 'turn.started', turnId: input.turnId });
    this.emit(state, { type: 'session.state.changed', status: 'running' });
    void this.run(state, input).then(
      (reason) => {
        if (state.turn !== input.turnId) return;
        // `cancelled` answers our own `session/cancel`, or follows a request
        // someone cancelled or declined; an agent that cancels unasked (Junie,
        // when every model refuses it) has failed. A vendor that ends its whole
        // turn once a tool call is declined (`declineEndsTurn`) has completed it.
        const endedByDecline =
          reason === 'cancelled' &&
          !state.interrupted &&
          state.declined &&
          !!this.hooks.declineEndsTurn;
        const interrupted =
          state.interrupted || (reason === 'cancelled' && state.refusedRequest && !endedByDecline);
        const completed = reason === 'end_turn' || endedByDecline;
        this.complete(
          state,
          interrupted ? 'interrupted' : completed ? 'completed' : 'error',
          interrupted
            ? 'Interrupted.'
            : completed
              ? undefined
              : reason === 'cancelled'
                ? `${this.hooks.label} cancelled the turn itself, without being interrupted.`
                : `${this.hooks.label} stopped: ${reason}`
        );
      },
      (error: unknown) => {
        if (state.turn !== input.turnId) return;
        this.complete(
          state,
          state.interrupted ? 'interrupted' : 'error',
          state.interrupted ? 'Interrupted.' : String(error)
        );
      }
    );
  }

  private async run(state: State, input: ProviderSendTurnInput): Promise<string> {
    if (input.model) await this.setModel(state.id, input.model);
    const prompt: Array<Record<string, unknown>> = [
      { type: 'text', text: state.context ? `${state.context}\n\n${input.text}` : input.text },
    ];
    state.context = '';
    for (const attachment of input.attachments ?? []) {
      const { mimeType, path } = attachment;
      const media = mimeType.startsWith('image/')
        ? state.prompt.image && 'image'
        : mimeType.startsWith('audio/')
          ? state.prompt.audio && 'audio'
          : undefined;
      if (media) {
        prompt.push({ type: media, data: (await readFile(path)).toString('base64'), mimeType });
      } else if (state.prompt.embeddedContext) {
        prompt.push({
          type: 'resource',
          resource: {
            uri: pathToFileURL(path).href,
            mimeType,
            ...(mimeType.startsWith('text/') || /json|xml/.test(mimeType)
              ? { text: await readFile(path, 'utf8') }
              : { blob: (await readFile(path)).toString('base64') }),
          },
        });
      } else {
        prompt.push({
          type: 'resource_link',
          uri: pathToFileURL(path).href,
          name: basename(path),
          mimeType,
        });
      }
    }
    return (
      await state.client.request<{ stopReason: string }>('session/prompt', {
        sessionId: state.nativeId,
        prompt,
      })
    ).stopReason;
  }

  async interruptTurn(id: string): Promise<void> {
    const state = this.require(id);
    if (!state.turn) return;
    state.interrupted = true;
    state.client.notify('session/cancel', { sessionId: state.nativeId });
    this.cancelPending(state);
  }

  async listModels(id: string): Promise<ModelChoice[]> {
    return this.require(id).models;
  }

  async setModel(id: string, model: ModelSelection): Promise<void> {
    const state = this.require(id);
    if (!modelConfigOption(state.configOptions)) {
      await state.client.request('session/set_model', {
        sessionId: state.nativeId,
        modelId: model.id,
      });
      return;
    }
    if (!state.models.some((choice) => choice.id === model.id))
      throw new ProviderSessionError(this.provider, id, `Unavailable model: ${model.id}`);
    await this.requestConfigOption(state, 'model', model.id);
  }

  /** Sets a session config option to a value it offers, as a provider's hooks ask for the runtime mode. */
  private async setConfigOption(state: State, configId: string, value: string): Promise<void> {
    const option = state.configOptions.find((candidate) => candidate.id === configId);
    if (!option) throw new Error(`${this.hooks.label} offers no '${configId}' session option.`);
    const offered = (option.options ?? []).flatMap((choice) =>
      'value' in choice ? [choice.value] : choice.options.map((nested) => nested.value)
    );
    if (option.type === 'select' && !offered.includes(value))
      throw new Error(
        `${this.hooks.label} does not offer '${value}' for its '${configId}' option; it offers ${offered.join(', ')}.`
      );
    await this.requestConfigOption(state, configId, value);
  }

  private async requestConfigOption(state: State, configId: string, value: string): Promise<void> {
    const result = await state.client.request<{ configOptions?: AcpConfigOption[] }>(
      'session/set_config_option',
      { sessionId: state.nativeId, configId, value }
    );
    if (result.configOptions) this.applyConfigOptions(state, result.configOptions);
  }

  async respondToRequest(id: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const state = this.require(id);
    const pending = state.decisions.get(requestId);
    if (!pending)
      throw new ProviderSessionError(this.provider, id, `No pending approval ${requestId}`);
    const response = pending.responses.get(decision);
    if (response === undefined && decision !== 'cancel' && decision !== 'decline')
      throw new ProviderSessionError(this.provider, id, `Decision ${decision} is not offered`);
    state.decisions.delete(requestId);
    if (decision === 'cancel' || decision === 'decline') state.refusedRequest = true;
    if (decision === 'decline') state.declined = true;
    pending.settle(response ?? ACP_CANCELLED);
    this.emit(state, { type: 'request.resolved', requestId, decision });
  }

  async respondToUserInput(
    id: string,
    requestId: string,
    answers: UserInputAnswers
  ): Promise<void> {
    const state = this.require(id);
    const pending = state.questions.get(requestId);
    if (!pending)
      throw new ProviderSessionError(this.provider, id, `No pending question ${requestId}`);
    const selected = pending.questions.map((question): AcpSelectedAnswer => {
      const answer = answers[question.id];
      const given = Array.isArray(answer) ? answer : typeof answer === 'string' ? [answer] : [];
      const offered = (value: string) => question.options.some((option) => option.value === value);
      const values = given.filter(offered);
      const typed = given.filter((value) => !offered(value));
      if (
        !given.length ||
        (!question.multiSelect && given.length !== 1) ||
        typed.length > (question.allowCustomAnswer ? 1 : 0)
      )
        throw new ProviderSessionError(
          this.provider,
          id,
          `Invalid answer for ${question.id}: choose one of the offered answers.`
        );
      return { questionId: question.id, values, ...(typed.length ? { custom: typed[0]! } : {}) };
    });
    state.questions.delete(requestId);
    pending.settle(pending.answer(selected));
    this.emit(state, { type: 'user-input.resolved', requestId });
  }

  private context(state: State): AcpSessionContext {
    const active = () => (state.turn && !state.interrupted ? state.turn : null);
    return {
      get turnId() {
        return active();
      },
      mcpServerNames: state.mcpNames,
      askQuestions: async (questions, answer) => {
        const turnId = active();
        if (!turnId) return ACP_CANCELLED;
        const requestId = randomUUID();
        return await new Promise((settle) => {
          state.questions.set(requestId, { questions, answer, settle });
          this.emit(state, { type: 'user-input.requested', turnId, requestId, questions });
        });
      },
      requestDecision: async ({ requestType, title, detail, options, connector }) => {
        const turnId = active();
        if (!turnId) return ACP_CANCELLED;
        const requestId = randomUUID();
        const responses = new Map<ApprovalDecision, unknown>();
        for (const option of options)
          if (option.decision !== 'cancel') responses.set(option.decision, option.response);
        return await new Promise((settle) => {
          state.decisions.set(requestId, { responses, settle });
          this.emit(state, {
            type: 'request.opened',
            turnId,
            requestId,
            requestType,
            title,
            ...(detail === undefined ? {} : { detail }),
            options: options.map(({ decision, label }) => ({ decision, label })),
            ...(connector === undefined ? {} : { connector }),
          });
        });
      },
      completeItem: (item) => {
        if (!state.turn) return;
        this.emit(state, { type: 'item.completed', turnId: state.turn, item });
      },
    };
  }

  private async permission(
    state: State,
    context: AcpSessionContext,
    request: AcpPermissionRequest
  ): Promise<unknown> {
    if (request.sessionId !== state.nativeId || !state.turn || state.interrupted)
      return ACP_CANCELLED;
    const vendor = this.hooks.permission?.(context, request);
    if (vendor) return await vendor;
    const { toolCall } = request;
    // The request's tool call updates one the agent announced and may name
    // nothing but its id: what it leaves out is the announced call's.
    const announced = state.items.get(toolCall.toolCallId);
    const kind =
      this.hooks.toolKind?.(toolCall.title ? toolCall : { ...toolCall, title: announced?.title }) ??
      toolCall.kind ??
      (announced?.type === 'command_execution'
        ? 'execute'
        : announced?.type === 'file_change'
          ? 'edit'
          : undefined);
    const once = request.options.find((option) => option.kind === 'allow_once');
    // The request's own call first, then the call as it was placed, asked
    // again with the request: an agent may name the server only across the two.
    const placed = state.mcpToolCalls.get(toolCall.toolCallId);
    const server =
      this.hooks.mcpServerOf?.(toolCall, state.mcpNames, toolCall) ??
      (placed && this.hooks.mcpServerOf?.(placed, state.mcpNames, toolCall));
    // In auto mode whatever automatic review the agent has ran before it
    // asked (see `sessionMode`), so a request that reaches here goes to a person.
    if (
      once &&
      ((server !== undefined && state.autoApprovedMcpNames.has(server)) ||
        state.runtimeMode === 'full-access' ||
        (state.runtimeMode === 'auto-accept-edits' && kind === 'edit'))
    )
      return { outcome: { outcome: 'selected', optionId: once.optionId } };
    const options: Array<{ decision: ApprovalDecision; label: string; response: unknown }> = [];
    const persistent = this.hooks.persistentPermissionKinds ?? [];
    for (const option of request.options) {
      if (persistent.includes(option.kind)) continue;
      const decision =
        option.kind === 'allow_once'
          ? 'accept'
          : option.kind === 'allow_always'
            ? 'acceptForSession'
            : option.kind === 'reject_once'
              ? 'decline'
              : undefined;
      // Permanent policies are intentionally not offered by this session UI.
      if (
        !decision ||
        options.some((offered) => offered.decision === decision) ||
        /future|permanent/i.test(`${option.optionId} ${option.name}`)
      )
        continue;
      options.push({
        decision,
        label: option.name,
        response: { outcome: { outcome: 'selected', optionId: option.optionId } },
      });
    }
    options.push({ decision: 'cancel', label: 'Cancel', response: ACP_CANCELLED });
    const mcp = server !== undefined && state.mcpNames.has(server);
    return await context.requestDecision({
      requestType: mcp
        ? 'mcp_tool_approval'
        : kind === 'execute'
          ? 'command_execution_approval'
          : kind === 'edit'
            ? 'file_change_approval'
            : 'tool_approval',
      title:
        this.hooks.toolTitle?.(toolCall) ??
        toolCall.title ??
        announced?.title ??
        `${this.hooks.label} needs permission`,
      options,
      ...(mcp && !state.autoApprovedMcpNames.has(server) ? { connector: server } : {}),
    });
  }

  private applyConfigOptions(state: State, options: AcpConfigOption[]): void {
    state.configOptions = options;
    if (modelConfigOption(options)) state.models = modelsFromConfig(options);
  }

  private update(state: State, update: AcpSessionUpdate): void {
    if (update.sessionUpdate === 'config_option_update' && update.configOptions) {
      this.applyConfigOptions(state, update.configOptions);
      return;
    }
    if (!state.turn) return;
    if (
      update.sessionUpdate === 'agent_message_chunk' &&
      update.content &&
      !Array.isArray(update.content) &&
      update.content.type === 'text'
    ) {
      if (!state.messageText)
        this.emit(state, {
          type: 'item.started',
          turnId: state.turn,
          item: {
            id: state.messageId,
            type: 'assistant_message',
            status: 'in_progress',
            title: '',
            text: '',
          },
        });
      state.messageText += update.content.text ?? '';
      this.emit(state, {
        type: 'content.delta',
        turnId: state.turn,
        itemId: state.messageId,
        delta: update.content.text ?? '',
      });
      return;
    }
    if (
      (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
      update.toolCallId
    )
      this.toolUpdate(state, state.turn, {
        ...update,
        toolCallId: update.toolCallId,
        content: Array.isArray(update.content) ? update.content : [],
      });
  }

  private toolUpdate(state: State, turnId: string, update: AcpToolCall): void {
    const old = state.items.get(update.toolCallId);
    const kind = this.hooks.toolKind?.(update) ?? update.kind;
    const server = this.hooks.mcpServerOf?.(update, state.mcpNames);
    if (server !== undefined) state.mcpToolCalls.set(update.toolCallId, update);
    const text = (update.content ?? [])
      .map((part) =>
        part.type === 'diff' ? `${part.path}\n${part.newText ?? ''}` : (part.content?.text ?? '')
      )
      .join('\n');
    const output = update.rawOutput;
    const outputFailed =
      output &&
      (Boolean(output.error) ||
        output.rejected === true ||
        output.permissionDenied === true ||
        (typeof output.exitCode === 'number' && output.exitCode !== 0));
    const resultText = output ? JSON.stringify(output, null, 2) : '';
    const toolText = [text, resultText].filter(Boolean).join('\n');
    const item: ProviderItem = {
      id: update.toolCallId,
      type:
        (old?.type !== 'tool_call' ? old?.type : undefined) ??
        this.hooks.itemType?.(update) ??
        (server !== undefined || update.toolCallId.startsWith('mcp_')
          ? 'mcp_tool_call'
          : kind === 'execute'
            ? 'command_execution'
            : kind === 'edit'
              ? 'file_change'
              : 'tool_call'),
      // A later update repeating the bare tool name keeps the hook's title.
      title:
        this.hooks.toolTitle?.(update) ??
        (this.hooks.toolTitle && old ? old.title : (update.title ?? old?.title)) ??
        'Tool',
      status: outputFailed
        ? 'failed'
        : update.status === 'completed'
          ? 'completed'
          : update.status === 'failed'
            ? 'failed'
            : (old?.status ?? 'in_progress'),
      ...(toolText || old?.text ? { text: toolText || old?.text } : {}),
    };
    state.items.set(item.id, item);
    // An item whose real type is learned only from a later update (Qwen names a
    // deferred `tool_call` as `agent` one update after announcing it) starts
    // again under that type, so a subagent is seen starting as a subagent.
    // Consumers key items by id, so the second start replaces the first.
    this.emit(state, {
      type:
        item.status === 'completed' || item.status === 'failed'
          ? 'item.completed'
          : old && old.type === item.type
            ? 'item.updated'
            : 'item.started',
      turnId,
      item,
    });
    this.finishMessage(state, 'completed');
    state.messageId = randomUUID();
  }

  private finishMessage(state: State, status: 'completed' | 'failed'): void {
    if (!state.turn || !state.messageText) return;
    this.emit(state, {
      type: 'item.completed',
      turnId: state.turn,
      item: {
        id: state.messageId,
        type: 'assistant_message',
        title: 'Assistant',
        status,
        text: state.messageText,
      },
    });
    state.messageText = '';
  }

  private complete(
    state: State,
    outcome: 'completed' | 'interrupted' | 'error',
    message?: string
  ): void {
    if (!state.turn) return;
    const turnId = state.turn;
    this.finishMessage(state, outcome === 'completed' ? 'completed' : 'failed');
    for (const item of state.items.values())
      if (item.status === 'in_progress') {
        if (outcome === 'completed') {
          outcome = 'error';
          message = `${this.hooks.label} ended the turn without confirming a pending tool result.`;
        }
        this.emit(state, {
          type: 'item.completed',
          turnId,
          item: {
            ...item,
            status: 'failed',
            ...(message ? { text: [item.text, message].filter(Boolean).join('\n') } : {}),
          },
        });
      }
    this.cancelPending(state);
    state.turn = null;
    this.emit(state, {
      type: 'turn.completed',
      turnId,
      outcome,
      ...(message ? { message } : {}),
      usage: [],
    });
    if (!state.turn)
      this.emit(state, {
        type: 'session.state.changed',
        status: state.stopping ? 'stopped' : outcome === 'error' ? 'error' : 'ready',
      });
    this.drain(state);
  }

  private cancelPending(state: State): void {
    for (const [requestId, pending] of state.questions) {
      pending.settle(ACP_CANCELLED);
      this.emit(state, { type: 'user-input.resolved', requestId });
    }
    state.questions.clear();
    for (const [requestId, pending] of state.decisions) {
      pending.settle(ACP_CANCELLED);
      this.emit(state, { type: 'request.resolved', requestId, decision: 'cancel' });
    }
    state.decisions.clear();
  }

  async stopSession(id: string): Promise<void> {
    const state = this.sessions.get(id);
    if (!state) return;
    state.stopping = true;
    if (state.turn) await this.interruptTurn(id);
    await state.client.dispose();
    this.exited(id, 'Session stopped');
    await this.tidy(state);
  }
  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stopSession(id)));
  }
  private exited(id: string, reason: string): void {
    const state = this.sessions.get(id);
    if (!state) return;
    const stopping = state.stopping;
    state.stopping = true;
    this.complete(state, stopping ? 'interrupted' : 'error', reason);
    this.cancelPending(state);
    for (const input of state.queue.splice(0))
      this.emit(state, {
        type: 'turn.completed',
        turnId: input.turnId,
        outcome: 'error',
        message: reason,
        usage: [],
      });
    this.sessions.delete(id);
    void this.tidy(state);
    this.emit(state, { type: 'session.state.changed', status: 'stopped' });
    this.emit(state, { type: 'session.exited', reason });
  }
  /**
   * Removes what `launch` prepared, once; every caller waits for the same
   * removal. A failure is only logged: the session is already gone.
   */
  private tidy(state: State): Promise<void> {
    state.tidied ??= (async () => {
      try {
        await state.cleanup?.();
      } catch (error) {
        this.logger.warn(`${this.hooks.label} could not remove what it prepared for a session.`, {
          sessionId: state.id,
          error: String(error),
        });
      }
    })();
    return state.tidied;
  }
  private require(id: string): State {
    const state = this.sessions.get(id);
    if (!state || !state.client.isAlive)
      throw new ProviderSessionError(this.provider, id, 'Session is not running');
    return state;
  }
  private emit(state: State, event: Emittable): void {
    const full = {
      ...event,
      eventId: randomUUID(),
      provider: this.provider,
      sessionId: state.id,
      createdAt: new Date().toISOString(),
    } as ProviderRuntimeEvent;
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch (cause) {
        this.logger.error(`${this.hooks.label} event listener failed`, { error: String(cause) });
      }
    }
  }
}

export function createAcpAdapter(hooks: AcpProviderHooks, options: AcpAdapterOptions): AcpAdapter {
  return new AcpAdapter(hooks, options);
}
