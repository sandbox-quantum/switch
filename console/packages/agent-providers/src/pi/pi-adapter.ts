import { randomUUID } from 'node:crypto';
import { readFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelChoice, SessionContext } from '@switch-console/shared/session-v1';
import {
  ProviderConversationUnavailableError,
  ProviderSessionError,
  type ModelSelection,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type RuntimeMode,
} from '../adapter';
import type {
  ApprovalDecision,
  ApprovalOption,
  ProviderItem,
  ProviderRuntimeEvent,
  TokenUsage,
  UserInputAnswers,
} from '../events';
import { noopLogger, type ProviderLogger } from '../transport/stdio-json-rpc';
import {
  PI_ALLOW,
  PI_BLOCK,
  PI_READY,
  PI_SESSION_ENV,
  PI_TOOL_CALL,
  piMcpServers,
  writePiSessionFiles,
  type PiToolCallQuestion,
} from './extension';
import {
  spawnPiRpc,
  type PiRecord,
  type PiResponse,
  type PiTransport,
  type PiTransportFactory,
} from './rpc-client';
import { PI_SIGN_IN_HINT } from './sign-in';
import { approvalRequest, asksPerson, exitCodeOf, resultText, toolItem } from './tools';

const PROVIDER = 'pi';
const LABEL = 'Pi';
export const PI_DEFAULT_BINARY = 'pi';

export interface PiAdapterOptions {
  /** Pi's executable; `pi` on PATH when undefined. */
  binaryPath?: string;
  logger?: ProviderLogger;
  /** How Pi is started and spoken to; tests give a scripted one. */
  transport?: PiTransportFactory;
  /** How long a starting Pi has to load the Switch extension and start its session. */
  readyTimeoutMs?: number;
}

const APPROVAL_OPTIONS: ApprovalOption[] = [
  { decision: 'accept', label: 'Allow once' },
  { decision: 'acceptForSession', label: 'Allow for this session' },
  { decision: 'decline', label: 'Decline' },
];

/** Thinking levels Pi takes on every model that reasons; it clamps them to what the model supports. */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];

interface Turn {
  id: string;
  usage: Map<string, TokenUsage>;
  /** Messages sent into this turn that Pi has not answered yet. */
  sending: number;
  /**
   * Pi settled while a message was still on its way. The turn ends once that
   * message is answered, unless the answer is that it started a new run.
   */
  settled: { aborted: boolean } | null;
  /** Why the model's last response failed, when it did. */
  error: string | null;
}

interface PendingApproval {
  /** The extension's question, answered when someone decides. */
  uiId: string;
  toolCallId: string;
  toolName: string;
}

interface State {
  id: string;
  nativeId: string;
  rpc: PiTransport;
  dir: string;
  runtimeMode: RuntimeMode;
  mcpNames: string[];
  autoApproved: Set<string>;
  connectors: Set<string>;
  allowedForSession: Set<string>;
  turn: Turn | null;
  interrupted: boolean;
  items: Map<string, ProviderItem>;
  /** Tool calls the gate blocked on a person's answer, so their result reads as declined. */
  declined: Set<string>;
  message: { id: string; text: string; started: boolean } | null;
  reasoning: { id: string; text: string } | null;
  compaction: string | null;
  approvals: Map<string, PendingApproval>;
  models: ModelChoice[];
  imageInput: boolean;
  stopping: boolean;
  /** Settled when the extension says its session started, or Pi exits first. */
  ready: Deferred | null;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Awaited where it matters; an exit after the start gave up must not surface as unhandled.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

type Emittable<T = ProviderRuntimeEvent> = T extends ProviderRuntimeEvent
  ? Omit<T, 'eventId' | 'provider' | 'sessionId' | 'createdAt'>
  : never;

type PiModel = {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  input?: string[];
};

function piModelId(model: ModelSelection): { provider: string; modelId: string } {
  const slash = model.id.indexOf('/');
  if (slash <= 0 || slash === model.id.length - 1)
    throw new Error(`A Pi model is named provider/model, not ${JSON.stringify(model.id)}.`);
  return { provider: model.id.slice(0, slash), modelId: model.id.slice(slash + 1) };
}

function modelChoice(model: PiModel): ModelChoice {
  return {
    id: `${model.provider}/${model.id}`,
    label: `${model.name ?? model.id} (${model.provider})`,
    options: model.reasoning ? { effort: THINKING_LEVELS } : {},
    imageInput: model.input?.includes('image') ?? null,
  };
}

function data(response: PiResponse): Record<string, unknown> {
  return response.data && typeof response.data === 'object'
    ? (response.data as Record<string, unknown>)
    : {};
}

function messageText(message: Record<string, unknown>, type: 'text' | 'thinking'): string {
  const content = message.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part: Record<string, unknown>) => part?.type === type)
    .map((part: Record<string, unknown>) => String(part[type] ?? ''))
    .join('');
}

/**
 * Pi (`pi --mode rpc`) as a Switch provider.
 *
 * Pi speaks its own JSONL protocol, not ACP, so this adapter is written for
 * it as Codex's is for app-server. Pi asks for no approvals of its own and
 * reads MCP servers from its configuration files; both come from the Switch
 * extension the host writes for each session (`extension.ts`), which
 * registers the session's servers and puts every tool call to this adapter.
 * The decision is made here (`asksPerson`), so the extension stays a gate.
 */
export class PiAdapter implements ProviderAdapter {
  readonly provider = PROVIDER;
  readonly capabilities: ProviderCapabilities = {
    modelSwitchInSession: true,
    steering: true,
    resume: true,
    approvals: true,
    userInput: false,
  };
  private readonly sessions = new Map<string, State>();
  private readonly listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly logger: ProviderLogger;
  private readonly transport: PiTransportFactory;

  constructor(private readonly options: PiAdapterOptions = {}) {
    this.logger = options.logger ?? noopLogger;
    this.transport = options.transport ?? spawnPiRpc;
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  async startSession(input: ProviderSessionStartInput) {
    if (this.sessions.has(input.sessionId))
      throw new ProviderSessionError(PROVIDER, input.sessionId, 'session already started');
    const cwd = await realpath(input.cwd);
    await refuseShadowedServers(input.sessionId, Object.keys(input.mcpServers), input.env, cwd);
    const files = await writePiSessionFiles(input.systemContext ?? '');
    const args = [
      '--mode',
      'rpc',
      '-e',
      files.extension,
      ...(files.systemPrompt ? ['--append-system-prompt', files.systemPrompt] : []),
      // A working folder's own `.pi` extensions, MCP servers and settings run
      // code no approval in the room covers, and the user's Pi config can make
      // Pi trust them. The extension above still loads: an explicit path is
      // not one of them.
      '--no-approve',
      // Pi opens this session, or creates it when there is none: whether
      // there was is checked below, so a lost conversation is not resumed empty.
      ...(input.resume ? ['--session-id', input.resume.nativeSessionId] : []),
    ];
    const env = {
      ...input.env,
      [PI_SESSION_ENV]: JSON.stringify({ mcpServers: piMcpServers(input.mcpServers, input.env) }),
    };
    const ready = deferred();
    const connectors = new Set(input.connectorMcpServers);
    const session: State = {
      id: input.sessionId,
      nativeId: '',
      dir: files.dir,
      runtimeMode: input.runtimeMode,
      mcpNames: Object.keys(input.mcpServers),
      autoApproved: new Set(Object.keys(input.mcpServers).filter((name) => !connectors.has(name))),
      connectors,
      allowedForSession: new Set(),
      turn: null,
      interrupted: false,
      items: new Map(),
      declined: new Set(),
      message: null,
      reasoning: null,
      compaction: null,
      approvals: new Map(),
      models: [],
      imageInput: false,
      stopping: false,
      ready,
      rpc: this.transport(
        { command: this.options.binaryPath ?? PI_DEFAULT_BINARY, args, cwd, env },
        {
          // Pi's records arrive after this object exists: none is read synchronously.
          onRecord: (record) => this.record(session, record),
          onExit: (reason) => this.exited(input.sessionId, reason),
          logger: this.logger,
        }
      ),
    };
    this.sessions.set(session.id, session);
    this.emit(session, { type: 'session.state.changed', status: 'starting' });
    const timeout = this.options.readyTimeoutMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Pi exits when an extension fails to load; waiting for the
      // extension's own word also proves its gate is in place before any turn.
      await Promise.race([
        ready.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`the Switch extension did not start within ${timeout} ms`)),
            timeout
          );
        }),
      ]);
      const current = data(await this.command(session, { type: 'get_state' }));
      session.nativeId = String(current.sessionId ?? '');
      if (!session.nativeId) throw new Error('Pi returned no session ID.');
      if (input.resume && current.messageCount === 0)
        throw new ProviderConversationUnavailableError(
          PROVIDER,
          input.sessionId,
          `Pi has no saved conversation ${input.resume.nativeSessionId} for ${cwd}.`
        );
      const model = current.model as PiModel | undefined;
      // Signed out, Pi 1.5 still starts, on a placeholder model that refuses
      // every prompt; a session on it would fail each turn the room sends.
      if (model?.provider === 'unknown' && !input.model)
        throw new Error(`Pi is not signed in to any model provider. ${PI_SIGN_IN_HINT}`);
      session.imageInput = model?.input?.includes('image') ?? false;
      session.models = await this.fetchModels(session);
      if (input.model) await this.setModel(session.id, input.model);
      this.emit(session, { type: 'session.started', nativeSessionId: session.nativeId });
      this.emit(session, { type: 'session.state.changed', status: 'ready' });
      return { provider: PROVIDER, sessionId: session.id, nativeSessionId: session.nativeId };
    } catch (cause) {
      const stderr = session.rpc.stderr;
      session.stopping = true;
      await session.rpc.dispose().catch(() => {});
      this.exited(session.id, 'Pi did not start');
      if (cause instanceof ProviderSessionError) throw cause;
      throw new ProviderSessionError(
        PROVIDER,
        session.id,
        `Could not start ${LABEL}: ${cause instanceof Error ? cause.message : String(cause)}${stderr ? `\n${stderr}` : ''}`,
        { cause }
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A send while a turn is running joins it: Pi delivers it after the
   * running tool calls, before the model's next request, and settles once.
   * Both go as `prompt` with `streamingBehavior: 'steer'`, which Pi starts
   * as a run of its own if it has already settled, so a send can never be
   * refused for arriving at the wrong moment.
   */
  async sendTurn(input: ProviderSendTurnInput) {
    const state = this.require(input.sessionId);
    if (input.model) await this.setModel(state.id, input.model);
    const message = await this.prompt(state, input);
    // Read after the awaits above, during which the running turn may have ended.
    const running = state.turn;
    const turn = running ?? {
      id: input.turnId,
      usage: new Map(),
      sending: 0,
      settled: null,
      error: null,
    };
    if (!running) {
      state.turn = turn;
      state.interrupted = false;
      state.items.clear();
      state.declined.clear();
      this.emit(state, { type: 'turn.started', turnId: turn.id });
      this.emit(state, { type: 'session.state.changed', status: 'running' });
    }
    turn.sending += 1;
    let response: PiResponse;
    try {
      response = await state.rpc.command({
        type: 'prompt',
        ...message,
        streamingBehavior: 'steer',
      });
    } catch (error) {
      turn.sending -= 1;
      if (running) throw new ProviderSessionError(PROVIDER, state.id, String(error));
      this.complete(state, 'error', String(error));
      return { turnId: input.turnId };
    }
    turn.sending -= 1;
    if (!response.success) {
      const reason = response.error ?? 'Pi refused the message.';
      if (running) throw new ProviderSessionError(PROVIDER, state.id, reason);
      this.complete(state, 'error', reason);
      return { turnId: input.turnId };
    }
    const disposition = data(response).disposition;
    if (running && disposition === 'started') {
      // Pi had settled before this message reached it and started a run for
      // it alone. The caller was told the message joined this turn, so the
      // turn waits for that run.
      turn.settled = null;
      state.interrupted = false;
    } else if (!running && disposition === 'handled') {
      // An extension command took the message and no run started.
      this.complete(state, 'completed');
      return { turnId: input.turnId };
    }
    if (turn.sending === 0 && turn.settled) this.settle(state, turn.settled.aborted);
    return running ? { turnId: input.turnId, steeredInto: running.id } : { turnId: input.turnId };
  }

  /**
   * Stops the running turn. The queue is cleared first, since Pi's abort goes
   * on to messages still queued; then the questions the extension is waiting
   * on are cancelled, since a tool call waiting for an answer holds the run
   * and Pi's abort waits for the run to stop.
   */
  async interruptTurn(id: string): Promise<void> {
    const state = this.require(id);
    if (!state.turn) return;
    state.interrupted = true;
    await this.command(state, { type: 'clear_queue' });
    this.cancelPending(state);
    await this.command(state, { type: 'abort' });
  }

  async listModels(id: string): Promise<ModelChoice[]> {
    const state = this.require(id);
    state.models = await this.fetchModels(state);
    return state.models;
  }

  async setModel(id: string, model: ModelSelection): Promise<void> {
    const state = this.require(id);
    let target: { provider: string; modelId: string };
    try {
      target = piModelId(model);
    } catch (error) {
      throw new ProviderSessionError(PROVIDER, id, String(error));
    }
    const chosen = data(await this.command(state, { type: 'set_model', ...target })) as PiModel;
    state.imageInput = chosen.input?.includes('image') ?? false;
    const effort = model.options?.effort;
    if (effort) await this.command(state, { type: 'set_thinking_level', level: effort });
  }

  async respondToRequest(id: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const state = this.require(id);
    const pending = state.approvals.get(requestId);
    if (!pending) throw new ProviderSessionError(PROVIDER, id, `No pending approval ${requestId}`);
    state.approvals.delete(requestId);
    if (decision === 'acceptForSession') state.allowedForSession.add(pending.toolName);
    if (decision === 'decline' || decision === 'cancel') state.declined.add(pending.toolCallId);
    this.answer(
      state,
      pending.uiId,
      decision === 'accept' || decision === 'acceptForSession'
        ? PI_ALLOW
        : decision === 'decline'
          ? PI_BLOCK
          : null
    );
    this.emit(state, { type: 'request.resolved', requestId, decision });
  }

  async respondToUserInput(id: string, requestId: string, _answers: UserInputAnswers) {
    throw new ProviderSessionError(PROVIDER, id, `Pi asks no questions; no request ${requestId}.`);
  }

  async contextUsage(id: string): Promise<Omit<SessionContext, 'updatedAt'> | null> {
    const state = this.require(id);
    const usage = data(await this.command(state, { type: 'get_session_stats' })).contextUsage as
      | { tokens?: number | null; contextWindow?: number | null }
      | undefined;
    if (typeof usage?.tokens !== 'number') return null;
    return { usedTokens: usage.tokens, windowTokens: usage.contextWindow ?? null };
  }

  async canCompact(id: string): Promise<boolean> {
    return this.require(id).turn === null;
  }

  async compactSession(id: string): Promise<void> {
    const state = this.require(id);
    if (state.turn) throw new ProviderSessionError(PROVIDER, id, 'Cannot compact during a turn.');
    await this.command(state, { type: 'compact' });
  }

  async stopSession(id: string): Promise<void> {
    const state = this.sessions.get(id);
    if (!state) return;
    state.stopping = true;
    if (state.turn && state.rpc.isAlive)
      await this.interruptTurn(id).catch((error: unknown) =>
        this.logger.warn('Pi did not stop its turn before the session ended', {
          error: String(error),
        })
      );
    await state.rpc.dispose();
    this.exited(id, 'Session stopped');
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stopSession(id)));
  }

  private async command(
    state: State,
    command: { type: string } & Record<string, unknown>
  ): Promise<PiResponse> {
    const response = await state.rpc.command(command);
    if (!response.success)
      throw new ProviderSessionError(
        PROVIDER,
        state.id,
        `Pi refused ${command.type}: ${response.error ?? 'no reason given'}`
      );
    return response;
  }

  private async fetchModels(state: State): Promise<ModelChoice[]> {
    const models = data(await this.command(state, { type: 'get_available_models' })).models;
    return Array.isArray(models) ? (models as PiModel[]).map(modelChoice) : [];
  }

  private async prompt(
    state: State,
    input: ProviderSendTurnInput
  ): Promise<{ message: string; images?: Array<Record<string, string>> }> {
    const lines = [input.text];
    const images: Array<Record<string, string>> = [];
    for (const attachment of input.attachments ?? []) {
      if (attachment.mimeType.startsWith('image/') && state.imageInput)
        images.push({
          type: 'image',
          data: (await readFile(attachment.path)).toString('base64'),
          mimeType: attachment.mimeType,
        });
      else lines.push(`Attached file (${attachment.mimeType}): ${attachment.path}`);
    }
    return { message: lines.join('\n\n'), ...(images.length ? { images } : {}) };
  }

  private record(state: State, record: PiRecord): void {
    switch (record.type) {
      case 'extension_ui_request':
        return this.uiRequest(state, record);
      case 'message_start':
        if ((record.message as { role?: string } | undefined)?.role === 'assistant') {
          state.message = { id: randomUUID(), text: '', started: false };
          state.reasoning = null;
        }
        return;
      case 'message_update':
        return this.messageUpdate(state, record.assistantMessageEvent as Record<string, unknown>);
      case 'message_end':
        return this.messageEnd(state, record.message as Record<string, unknown>);
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
        return this.toolEvent(state, record);
      case 'compaction_start':
        if (!state.turn) return;
        state.compaction = randomUUID();
        this.emit(state, {
          type: 'item.started',
          turnId: state.turn.id,
          item: {
            id: state.compaction,
            type: 'context_compaction',
            status: 'in_progress',
            title: 'Compacting the conversation',
          },
        });
        return;
      case 'compaction_end':
        if (!state.turn || !state.compaction) return;
        this.emit(state, {
          type: 'item.completed',
          turnId: state.turn.id,
          item: {
            id: state.compaction,
            type: 'context_compaction',
            status: record.result ? 'completed' : 'failed',
            title: 'Compacting the conversation',
            ...(typeof record.errorMessage === 'string' ? { text: record.errorMessage } : {}),
          },
        });
        state.compaction = null;
        return;
      case 'auto_retry_start':
        this.emit(state, {
          type: 'runtime.warning',
          message: `Pi is retrying the model (attempt ${String(record.attempt)} of ${String(record.maxAttempts)}): ${String(record.errorMessage ?? 'no reason given')}`,
        });
        return;
      case 'auto_retry_end':
        if (record.success === false && state.turn)
          state.turn.error = String(record.finalError ?? 'Pi stopped retrying the model.');
        return;
      case 'extension_error':
        this.emit(state, {
          type: 'runtime.warning',
          message: `A Pi extension failed (${String(record.event)}): ${String(record.error)}`,
        });
        return;
      case 'agent_settled':
        return this.settle(state, record.aborted === true);
      default:
        return;
    }
  }

  private uiRequest(state: State, request: PiRecord): void {
    const uiId = String(request.id);
    const method = request.method;
    if (method === 'notify') {
      if (request.message === PI_READY) {
        state.ready?.resolve();
        state.ready = null;
      } else if (request.notifyType === 'warning' || request.notifyType === 'error')
        this.emit(state, { type: 'runtime.warning', message: String(request.message) });
      return;
    }
    if (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor')
      return;
    const question = method === 'select' ? toolCallQuestion(request.title) : null;
    if (!question) {
      // Another extension of the user's asking something only Pi's own
      // interface could show: it is told no, and the room is told it was.
      this.answer(state, uiId, null);
      this.emit(state, {
        type: 'runtime.warning',
        message: `A Pi extension asked "${String(request.title)}", which Switch cannot show; it was cancelled.`,
      });
      return;
    }
    const turn = state.turn;
    if (!turn || state.interrupted) return this.answer(state, uiId, null);
    if (
      !asksPerson(question, {
        runtimeMode: state.runtimeMode,
        autoApproved: state.autoApproved,
        connectors: state.connectors,
        allowedForSession: state.allowedForSession,
      })
    )
      return this.answer(state, uiId, PI_ALLOW);
    const requestId = randomUUID();
    state.approvals.set(requestId, {
      uiId,
      toolCallId: question.toolCallId,
      toolName: question.toolName,
    });
    this.emit(state, {
      type: 'request.opened',
      turnId: turn.id,
      requestId,
      ...approvalRequest(question, state.connectors),
      options: APPROVAL_OPTIONS,
    });
  }

  /** Answers the extension's question: allow, block, or cancelled (`null`). */
  private answer(
    state: State,
    uiId: string,
    value: typeof PI_ALLOW | typeof PI_BLOCK | null
  ): void {
    try {
      state.rpc.send({
        type: 'extension_ui_response',
        id: uiId,
        ...(value === null ? { cancelled: true } : { value }),
      });
    } catch (error) {
      // Pi has gone, and its exit ends the turn; the call it asked about never ran.
      this.logger.warn('Pi was gone before a tool call was answered', { error: String(error) });
    }
  }

  private messageUpdate(state: State, event: Record<string, unknown> | undefined): void {
    const turn = state.turn;
    if (!turn || !event || !state.message) return;
    // An empty delta opens nothing: Gemini sends one before a tool call, and a
    // message with no text is never completed.
    if (event.type === 'text_delta' && typeof event.delta === 'string' && event.delta) {
      const message = state.message;
      if (!message.started) {
        message.started = true;
        this.emit(state, {
          type: 'item.started',
          turnId: turn.id,
          item: {
            id: message.id,
            type: 'assistant_message',
            status: 'in_progress',
            title: '',
            text: '',
          },
        });
      }
      message.text += event.delta;
      this.emit(state, {
        type: 'content.delta',
        turnId: turn.id,
        itemId: message.id,
        delta: event.delta,
      });
    } else if (event.type === 'thinking_delta' && typeof event.delta === 'string' && event.delta) {
      if (!state.reasoning) {
        state.reasoning = { id: randomUUID(), text: '' };
        this.emit(state, {
          type: 'item.started',
          turnId: turn.id,
          item: {
            id: state.reasoning.id,
            type: 'reasoning',
            status: 'in_progress',
            title: 'Reasoning',
          },
        });
      }
      state.reasoning.text += event.delta;
      this.emit(state, {
        type: 'item.delta',
        turnId: turn.id,
        itemId: state.reasoning.id,
        delta: event.delta,
      });
    } else if (event.type === 'thinking_end' && state.reasoning) {
      const content = typeof event.content === 'string' ? event.content : state.reasoning.text;
      this.emit(state, {
        type: 'item.completed',
        turnId: turn.id,
        item: {
          id: state.reasoning.id,
          type: 'reasoning',
          status: 'completed',
          title: 'Reasoning',
          text: content,
        },
      });
      state.reasoning = null;
    }
  }

  private messageEnd(state: State, message: Record<string, unknown> | undefined): void {
    const turn = state.turn;
    if (!turn || message?.role !== 'assistant') return;
    const usage = message.usage as Record<string, number> | undefined;
    if (usage) {
      const model = `${String(message.provider)}/${String(message.model)}`;
      const total = turn.usage.get(model) ?? {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      total.inputTokens += usage.input ?? 0;
      total.outputTokens += usage.output ?? 0;
      total.cacheReadTokens += usage.cacheRead ?? 0;
      total.cacheWriteTokens += usage.cacheWrite ?? 0;
      turn.usage.set(model, total);
    }
    if (message.stopReason === 'error')
      turn.error = String(message.errorMessage ?? 'The model returned an error.');
    const text = messageText(message, 'text');
    const current = state.message ?? { id: randomUUID(), text: '', started: false };
    state.message = null;
    if (!text) return;
    if (!current.started)
      this.emit(state, {
        type: 'item.started',
        turnId: turn.id,
        item: {
          id: current.id,
          type: 'assistant_message',
          status: 'in_progress',
          title: '',
          text: '',
        },
      });
    this.emit(state, {
      type: 'item.completed',
      turnId: turn.id,
      item: {
        id: current.id,
        type: 'assistant_message',
        status: message.stopReason === 'aborted' ? 'failed' : 'completed',
        title: 'Assistant',
        text,
      },
    });
  }

  private toolEvent(state: State, record: PiRecord): void {
    const turn = state.turn;
    const id = String(record.toolCallId);
    if (!turn) return;
    if (record.type === 'tool_execution_start') {
      const item = toolItem(id, String(record.toolName), record.args, state.mcpNames);
      state.items.set(id, item);
      this.emit(state, { type: 'item.started', turnId: turn.id, item });
      return;
    }
    const started =
      state.items.get(id) ?? toolItem(id, String(record.toolName), record.args, state.mcpNames);
    if (record.type === 'tool_execution_update') {
      const text = resultText(record.partialResult);
      const item = { ...started, ...(text ? { text } : {}) };
      state.items.set(id, item);
      this.emit(state, { type: 'item.updated', turnId: turn.id, item });
      return;
    }
    const exitCode = exitCodeOf(record.result);
    const text = resultText(record.result);
    const item: ProviderItem = {
      ...started,
      status: state.declined.has(id)
        ? 'declined'
        : record.isError === true
          ? 'failed'
          : 'completed',
      ...(text ? { text } : {}),
      ...(exitCode === undefined ? {} : { payload: { ...started.payload, exitCode } }),
    };
    state.items.set(id, item);
    this.emit(state, { type: 'item.completed', turnId: turn.id, item });
  }

  private settle(state: State, aborted: boolean): void {
    const turn = state.turn;
    if (!turn) return;
    if (turn.sending > 0) {
      turn.settled = { aborted };
      return;
    }
    if (aborted) this.complete(state, 'interrupted', 'Interrupted.');
    else if (turn.error) this.complete(state, 'error', turn.error);
    else this.complete(state, 'completed');
  }

  private complete(
    state: State,
    outcome: 'completed' | 'interrupted' | 'error',
    message?: string
  ): void {
    const turn = state.turn;
    if (!turn) return;
    if (state.message?.started && state.message.text)
      this.emit(state, {
        type: 'item.completed',
        turnId: turn.id,
        item: {
          id: state.message.id,
          type: 'assistant_message',
          status: 'failed',
          title: 'Assistant',
          text: state.message.text,
        },
      });
    state.message = null;
    state.reasoning = null;
    state.compaction = null;
    for (const item of state.items.values())
      if (item.status === 'in_progress') {
        if (outcome === 'completed') {
          outcome = 'error';
          message = 'Pi settled without finishing a tool call.';
        }
        this.emit(state, {
          type: 'item.completed',
          turnId: turn.id,
          item: {
            ...item,
            status: 'failed',
            ...(message ? { text: [item.text, message].filter(Boolean).join('\n') } : {}),
          },
        });
      }
    state.items.clear();
    this.cancelPending(state);
    state.turn = null;
    // A turn that failed (the model's last attempt, a refused prompt) leaves Pi
    // itself running, so the session stays ready for the next message. Pi
    // exiting is the one failure that ends it, and that path is stopping.
    if (outcome === 'error' && !state.stopping)
      this.emit(state, { type: 'runtime.error', message: message ?? 'The Pi turn failed.' });
    this.emit(state, {
      type: 'turn.completed',
      turnId: turn.id,
      outcome,
      ...(message ? { message } : {}),
      usage: [...turn.usage.values()],
    });
    this.emit(state, {
      type: 'session.state.changed',
      status: state.stopping ? 'stopped' : 'ready',
    });
  }

  private cancelPending(state: State): void {
    for (const [requestId, pending] of state.approvals) {
      state.declined.add(pending.toolCallId);
      this.answer(state, pending.uiId, null);
      this.emit(state, { type: 'request.resolved', requestId, decision: 'cancel' });
    }
    state.approvals.clear();
  }

  private exited(id: string, reason: string): void {
    const state = this.sessions.get(id);
    if (!state) return;
    const stopping = state.stopping;
    state.stopping = true;
    state.ready?.reject(new Error(reason));
    state.ready = null;
    this.complete(state, stopping ? 'interrupted' : 'error', reason);
    this.sessions.delete(id);
    void rm(state.dir, { recursive: true, force: true }).catch((error: unknown) =>
      this.logger.warn('Could not remove a Pi session folder', { error: String(error) })
    );
    this.emit(state, { type: 'session.state.changed', status: 'stopped' });
    this.emit(state, { type: 'session.exited', reason });
  }

  private require(id: string): State {
    const state = this.sessions.get(id);
    if (!state || !state.rpc.isAlive)
      throw new ProviderSessionError(PROVIDER, id, 'Session is not running');
    return state;
  }

  private emit(state: State, event: Emittable): void {
    const full = {
      ...event,
      eventId: randomUUID(),
      provider: PROVIDER,
      sessionId: state.id,
      createdAt: new Date().toISOString(),
    } as ProviderRuntimeEvent;
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch (cause) {
        this.logger.error('Pi event listener failed', { error: String(cause) });
      }
    }
  }
}

function toolCallQuestion(title: unknown): PiToolCallQuestion | null {
  if (typeof title !== 'string' || !title.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(title) as Partial<PiToolCallQuestion>;
    return parsed.switch === PI_TOOL_CALL &&
      typeof parsed.toolCallId === 'string' &&
      typeof parsed.toolName === 'string'
      ? (parsed as PiToolCallQuestion)
      : null;
  } catch {
    return null;
  }
}

/** Pi's server-name rule: names differing only in `-` and `_` are the same server. */
function serverKey(name: string): string {
  return name.replaceAll('-', '_');
}

/**
 * Refuses a session whose MCP servers a Pi configuration file would replace.
 * Pi prefers a server in `mcp.json` to a registered one of the same name, so
 * a user's own `switch` entry would quietly take the place of this session's
 * Switch tools. The user's files are read, never changed.
 */
async function refuseShadowedServers(
  sessionId: string,
  names: string[],
  env: Record<string, string>,
  cwd: string
): Promise<void> {
  const agentDir =
    env.PI_CODING_AGENT_DIR || join(env.HOME || env.USERPROFILE || homedir(), '.pi', 'agent');
  const ours = new Map(names.map((name) => [serverKey(name), name]));
  for (const file of [join(agentDir, 'mcp.json'), join(cwd, '.pi', 'mcp.json')]) {
    let servers: Record<string, Record<string, unknown>>;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { mcpServers?: unknown };
      if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') continue;
      servers = parsed.mcpServers as Record<string, Record<string, unknown>>;
    } catch {
      // Missing, or not JSON Pi could read either: Pi reports the latter itself.
      continue;
    }
    for (const [name, entry] of Object.entries(servers)) {
      const defines = entry && ('command' in entry || 'url' in entry || 'type' in entry);
      const shadowed = ours.get(serverKey(name));
      if (defines && shadowed !== undefined)
        throw new ProviderSessionError(
          PROVIDER,
          sessionId,
          `${file} defines an MCP server named "${name}", which Pi would use in place of this session's "${shadowed}". Rename that entry.`
        );
    }
  }
}

export function createPiAdapter(options: PiAdapterOptions = {}): PiAdapter {
  return new PiAdapter(options);
}
