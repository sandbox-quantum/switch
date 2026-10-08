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
export async function acpInitialize(client: StdioJsonRpcClient): Promise<AcpInitializeResult> {
  return await client.request<AcpInitializeResult>('initialize', {
    protocolVersion: 1,
    clientInfo: ACP_CLIENT_INFO,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
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
  context: string;
  runtimeMode: ProviderSessionStartInput['runtimeMode'];
  mcpNames: Set<string>;
  toolServers: Map<string, string>;
  prompt: AcpPromptCapabilities;
  configOptions: AcpConfigOption[];
  models: ModelChoice[];
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
    const launch = await hooks.launch({
      binaryPath: this.options.binaryPath ?? hooks.defaultBinary,
      cwd,
      env: input.env,
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
      context: input.systemContext ?? '',
      runtimeMode: input.runtimeMode,
      mcpNames: new Set(Object.keys(input.mcpServers)),
      toolServers: new Map(),
      prompt: {},
      configOptions: [],
      models: [],
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
      const initialized = await acpInitialize(client);
      const agent = initialized.agentCapabilities ?? {};
      requireHttpMcp(hooks.label, input.mcpServers, agent.mcpCapabilities?.http);
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
      if (hooks.authMethodId)
        await client.request('authenticate', { methodId: hooks.authMethodId });
      const mcpServers = acpMcpServers(input.mcpServers, input.env);
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
      const mode = hooks.sessionMode?.(input.runtimeMode);
      if (mode)
        await client.request('session/set_mode', { sessionId: state.nativeId, modeId: mode });
      if (input.model) await this.setModel(state.id, input.model);
      const nativeSessionId = `${prefix?.prefix ?? ''}${state.nativeId}`;
      this.emit(state, { type: 'session.started', nativeSessionId });
      this.emit(state, { type: 'session.state.changed', status: 'ready' });
      return { provider: hooks.provider, sessionId: state.id, nativeSessionId };
    } catch (cause) {
      await client.dispose();
      this.sessions.delete(state.id);
      if (cause instanceof ProviderConversationUnavailableError) throw cause;
      const details =
        cause instanceof JsonRpcError &&
        typeof cause.data === 'object' &&
        cause.data !== null &&
        'details' in cause.data
          ? String(cause.data.details)
          : '';
      throw new ProviderSessionError(
        hooks.provider,
        state.id,
        `Could not start ${hooks.label}: ${String(cause)}${details ? `: ${details}` : ''}${client.stderr ? `\n${client.stderr}` : ''}`,
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
    state.messageId = randomUUID();
    state.items.clear();
    state.toolServers.clear();
    this.emit(state, { type: 'turn.started', turnId: input.turnId });
    this.emit(state, { type: 'session.state.changed', status: 'running' });
    void this.run(state, input).then(
      (reason) => {
        if (state.turn !== input.turnId) return;
        const interrupted = state.interrupted || reason === 'cancelled';
        this.complete(
          state,
          interrupted ? 'interrupted' : reason === 'end_turn' ? 'completed' : 'error',
          interrupted
            ? 'Interrupted.'
            : reason === 'end_turn'
              ? undefined
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
    const result = await state.client.request<{ configOptions?: AcpConfigOption[] }>(
      'session/set_config_option',
      { sessionId: state.nativeId, configId: 'model', value: model.id }
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
    const selected = pending.questions.map((question) => {
      const answer = answers[question.id];
      const values = Array.isArray(answer) ? answer : typeof answer === 'string' ? [answer] : [];
      if (
        !values.length ||
        (!question.multiSelect && values.length !== 1) ||
        values.some((value) => !question.options.some((option) => option.value === value))
      )
        throw new ProviderSessionError(
          this.provider,
          id,
          `Invalid answer for ${question.id}: choose one of the offered answers.`
        );
      return { questionId: question.id, values };
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
      requestDecision: async ({ requestType, title, detail, options }) => {
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
    const once = request.options.find((option) => option.kind === 'allow_once');
    const server = this.hooks.mcpServerOf?.(toolCall) ?? state.toolServers.get(toolCall.toolCallId);
    if (
      once &&
      ((server !== undefined && state.mcpNames.has(server)) ||
        state.runtimeMode === 'full-access' ||
        (state.runtimeMode === 'auto-accept-edits' && toolCall.kind === 'edit'))
    )
      return { outcome: { outcome: 'selected', optionId: once.optionId } };
    const options: Array<{ decision: ApprovalDecision; label: string; response: unknown }> = [];
    for (const option of request.options) {
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
        /future|permanent/i.test(option.name)
      )
        continue;
      options.push({
        decision,
        label: option.name,
        response: { outcome: { outcome: 'selected', optionId: option.optionId } },
      });
    }
    options.push({ decision: 'cancel', label: 'Cancel', response: ACP_CANCELLED });
    return await context.requestDecision({
      requestType:
        toolCall.kind === 'execute'
          ? 'command_execution_approval'
          : toolCall.kind === 'edit'
            ? 'file_change_approval'
            : 'tool_approval',
      title: toolCall.title ?? `${this.hooks.label} needs permission`,
      options,
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
    const server = this.hooks.mcpServerOf?.(update);
    if (server !== undefined) state.toolServers.set(update.toolCallId, server);
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
          : update.kind === 'execute'
            ? 'command_execution'
            : update.kind === 'edit'
              ? 'file_change'
              : 'tool_call'),
      title: update.title ?? old?.title ?? 'Tool',
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
    this.emit(state, {
      type:
        item.status === 'completed' || item.status === 'failed'
          ? 'item.completed'
          : old
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
    this.emit(state, { type: 'session.state.changed', status: 'stopped' });
    this.emit(state, { type: 'session.exited', reason });
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
