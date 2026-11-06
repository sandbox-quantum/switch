import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  ItemType,
  ProviderItem,
  ProviderRuntimeEvent,
  RequestType,
  TokenUsage,
  UserInputAnswers,
  UserInputQuestion,
} from '../events';
import { mcpApprovalContent, toolInputDetail } from '../mcp-approval';
import { noopLogger, type ProviderLogger } from '../transport/stdio-json-rpc';
import {
  APPROVAL_OPTIONS,
  decodeDialog,
  piModelId,
  SWITCH_EXTENSION_COMMAND,
  SWITCH_EXTENSION_CONFIG_ENV,
  type PiCommandInfo,
  type PiEvent,
  type PiMessage,
  type PiModel,
  type PiState,
  type PiUiRequest,
  type PiUiResponse,
  type SwitchDialog,
} from './protocol';
import { PiRpcClient } from './rpc';
import { piMcpServers, writeSwitchExtension, writeSwitchExtensionConfig } from './switch-extension';

const PROVIDER = 'pi';
const LABEL = 'Pi';

export interface PiAdapterOptions {
  /** The `pi` executable; `pi` on the PATH when undefined. */
  binaryPath?: string | undefined;
  logger?: ProviderLogger;
}

/**
 * Pi has no steering the host could use (it runs one turn at a time and queues
 * the next message itself), no permission modes of its own (the extension
 * asks, see `switch-extension.ts`) and resumes a conversation from its session
 * file.
 */
const CAPABILITIES: ProviderCapabilities = {
  modelSwitchInSession: true,
  steering: false,
  resume: true,
  approvals: true,
  userInput: true,
};

type Pending =
  | { kind: 'approval'; toolCallId?: string; responses: Map<ApprovalDecision, PiUiResponse> }
  | {
      kind: 'question';
      question: UserInputQuestion;
      answer: (answer: string | string[]) => PiUiResponse;
    };

interface State {
  id: string;
  /** Pi's session file, which is what a later session resumes from. */
  sessionFile: string;
  client: PiRpcClient;
  /** Switch's scratch directory for this session: the extension, its settings, the context. */
  directory: string;
  turn: string | null;
  queue: ProviderSendTurnInput[];
  stopping: boolean;
  interrupted: boolean;
  starting: boolean;
  /** What the extension reported failing while Pi started. */
  extensionErrors: string[];
  models: PiModel[];
  /** The model in use, as `provider/id`; empty when Pi has none. */
  model: string;
  items: Map<string, ProviderItem>;
  /** Tool calls the person rejected, whose results are declined rather than failed. */
  declined: Set<string>;
  pending: Map<string, Pending>;
  messageId: string;
  messageText: string;
  usage: Map<string, TokenUsage>;
  /** Why the run's last model response failed, until a later one succeeds. */
  failure: string | undefined;
}

type Emittable<T = ProviderRuntimeEvent> = T extends ProviderRuntimeEvent
  ? Omit<T, 'eventId' | 'provider' | 'sessionId' | 'createdAt'>
  : never;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const CANCEL = (id: string): PiUiResponse => ({
  type: 'extension_ui_response',
  id,
  cancelled: true,
});

const textOf = (content: PiMessage['content']): string =>
  typeof content === 'string'
    ? content
    : (content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');

const truncate = (value: string, max = 160): string => {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
};

/** The server and tool in Pi's `mcp__<server>__<tool>` name. */
function mcpTool(toolName: string): { server: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match ? { server: match[1]!, tool: match[2]! } : undefined;
}

function itemTypeFor(toolName: string): ItemType {
  if (toolName === 'bash') return 'command_execution';
  if (toolName === 'edit' || toolName === 'write') return 'file_change';
  return mcpTool(toolName) ? 'mcp_tool_call' : 'tool_call';
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** The line an activity row shows for a tool call. */
function toolTitle(toolName: string, args: Record<string, unknown>): string {
  const mcp = mcpTool(toolName);
  if (mcp) return `${mcp.server}: ${mcp.tool}`;
  const target = stringArg(args, 'command', 'path', 'pattern', 'question');
  return target
    ? toolName === 'bash'
      ? truncate(target)
      : `${toolName} ${truncate(target)}`
    : toolName;
}

/**
 * What an approval card says. `detail` is the literal thing approved: the
 * command, the path, a tool's input.
 */
function approvalContent(
  dialog: Extract<SwitchDialog, { kind: 'approval' }>,
  args: Record<string, unknown>
): { requestType: RequestType; title: string; detail?: string } {
  const { toolName, server } = dialog;
  const mcp = server === undefined ? undefined : mcpTool(toolName);
  if (server !== undefined)
    return {
      requestType: 'mcp_tool_approval',
      ...mcpApprovalContent(server, mcp?.tool ?? toolName, args),
    };
  if (toolName === 'bash') {
    const command = stringArg(args, 'command');
    return {
      requestType: 'command_execution_approval',
      title: 'Run a command',
      ...(command ? { detail: command } : {}),
    };
  }
  if (toolName === 'edit' || toolName === 'write') {
    const path = stringArg(args, 'path');
    return {
      requestType: 'file_change_approval',
      title: toolName === 'write' ? 'Write a file' : 'Edit a file',
      ...(path ? { detail: path } : {}),
    };
  }
  const detail = toolInputDetail(args);
  return { requestType: 'tool_approval', title: `Use ${toolName}`, ...(detail ? { detail } : {}) };
}

/**
 * Pi, driven over its RPC mode (`pi --mode rpc`), one process per session.
 *
 * Pi streams its own events and answers commands; it never asks permission,
 * so Switch's extension (`switch-extension.ts`) is loaded into every session
 * to register the session's MCP servers, gate tool calls on the runtime mode
 * and ask questions, through the extension dialogs RPC mode forwards.
 *
 * A turn lasts until Pi reports `agent_settled`, which is when it will not go
 * on by itself (`agent_end` can be followed by a retry or a queued message).
 * A message sent mid-turn waits in this adapter's queue and gets its own turn.
 */
export class PiAdapter implements ProviderAdapter {
  readonly provider = PROVIDER;
  readonly capabilities = CAPABILITIES;
  private readonly sessions = new Map<string, State>();
  private readonly listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly logger: ProviderLogger;

  constructor(private readonly options: PiAdapterOptions) {
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
    if (this.hasSession(input.sessionId))
      throw new ProviderSessionError(PROVIDER, input.sessionId, 'session already started');
    const cwd = await realpath(input.cwd);
    // Pi would start a new conversation at a path that holds none.
    if (input.resume)
      await access(input.resume.nativeSessionId).catch(() => {
        throw new ProviderConversationUnavailableError(
          PROVIDER,
          input.sessionId,
          'The saved Pi conversation is no longer on this machine.'
        );
      });
    const directory = await mkdtemp(join(tmpdir(), 'switch-pi-'));
    let client: PiRpcClient | undefined;
    try {
      const extension = await writeSwitchExtension(directory);
      const config = await writeSwitchExtensionConfig(directory, {
        runtimeMode: input.runtimeMode,
        mcpServers: piMcpServers(input.mcpServers, input.env),
        connectorMcpServers: input.connectorMcpServers,
      });
      const args = ['--mode', 'rpc', '-e', extension];
      if (input.systemContext) {
        const context = join(directory, 'context.md');
        await writeFile(context, input.systemContext, { mode: 0o600 });
        args.push('--append-system-prompt', context);
      }
      if (input.resume) args.push('--session', input.resume.nativeSessionId);
      const spawned = new PiRpcClient({
        command: this.options.binaryPath ?? 'pi',
        args,
        cwd,
        // Pi's version check is a network request at every start.
        env: { ...input.env, PI_SKIP_VERSION_CHECK: '1', [SWITCH_EXTENSION_CONFIG_ENV]: config },
        logger: this.logger,
        onEvent: (event) => this.event(state, event),
        onUiRequest: (request) => this.dialog(state, request),
        onExit: (reason) => this.exited(input.sessionId, reason),
      });
      client = spawned;
      // The callbacks above run only once Pi has written something.
      const state: State = {
        id: input.sessionId,
        sessionFile: '',
        client: spawned,
        directory,
        turn: null,
        queue: [],
        stopping: false,
        interrupted: false,
        starting: true,
        extensionErrors: [],
        models: [],
        model: '',
        items: new Map(),
        declined: new Set(),
        pending: new Map(),
        messageId: randomUUID(),
        messageText: '',
        usage: new Map(),
        failure: undefined,
      };
      this.sessions.set(state.id, state);
      this.emit(state, { type: 'session.state.changed', status: 'starting' });
      await this.handshake(state, config);
      if (input.model) await this.setModel(state.id, input.model);
      state.starting = false;
      this.emit(state, { type: 'session.started', nativeSessionId: state.sessionFile });
      this.emit(state, { type: 'session.state.changed', status: 'ready' });
      return { provider: PROVIDER, sessionId: state.id, nativeSessionId: state.sessionFile };
    } catch (cause) {
      this.sessions.delete(input.sessionId);
      const stderr = client?.stderr;
      await client?.dispose().catch(() => {});
      await rm(directory, { recursive: true, force: true });
      if (cause instanceof ProviderConversationUnavailableError) throw cause;
      throw new ProviderSessionError(
        PROVIDER,
        input.sessionId,
        `Could not start ${LABEL}: ${String(cause)}${stderr ? `\n${stderr}` : ''}`,
        { cause }
      );
    }
  }

  /**
   * Asks Pi what it needs to know before a turn, and that the Switch
   * extension loaded: Pi goes on without an extension that failed to, and a
   * session without it would have no Switch tools and no approvals.
   */
  private async handshake(state: State, configPath: string): Promise<void> {
    const { client } = state;
    const pi = await client.request<PiState>('get_state');
    const { commands } = await client.request<{ commands: PiCommandInfo[] }>('get_commands');
    if (!commands.some((command) => command.name === SWITCH_EXTENSION_COMMAND)) {
      const errors = state.extensionErrors.join('; ');
      throw new Error(
        `Pi did not load the Switch extension, so the session would have no Switch tools and no approvals${errors ? `: ${errors}` : '.'}`
      );
    }
    // It has read its settings, which hold the session's MCP credentials.
    await rm(configPath, { force: true });
    if (!pi.sessionFile) throw new Error('Pi did not name a session file.');
    state.sessionFile = pi.sessionFile;
    // Pi reports a placeholder model when it has none to use.
    state.model = pi.model && pi.model.provider !== 'unknown' ? piModelId(pi.model) : '';
    state.models = (await client.request<{ models: PiModel[] }>('get_available_models')).models;
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
    state.failure = undefined;
    state.messageId = randomUUID();
    state.messageText = '';
    state.items.clear();
    state.declined.clear();
    state.usage.clear();
    this.emit(state, { type: 'turn.started', turnId: input.turnId });
    this.emit(state, { type: 'session.state.changed', status: 'running' });
    void this.run(state, input).then(
      (started) => {
        // A prompt an extension command consumed starts no run to wait for.
        if (!started && state.turn === input.turnId) this.complete(state, 'completed');
      },
      (error: unknown) => {
        if (state.turn !== input.turnId) return;
        this.complete(
          state,
          state.interrupted ? 'interrupted' : 'error',
          state.interrupted
            ? 'Interrupted.'
            : error instanceof Error
              ? error.message
              : String(error)
        );
      }
    );
  }

  /** Sends the turn's prompt; resolves with whether Pi started a run for it. */
  private async run(state: State, input: ProviderSendTurnInput): Promise<boolean> {
    if (input.model) await this.setModel(state.id, input.model);
    const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
    const files: string[] = [];
    const sendsImages = state.models.find((model) => piModelId(model) === state.model)?.input;
    for (const { path, mimeType } of input.attachments ?? []) {
      if (mimeType.startsWith('image/') && sendsImages?.includes('image'))
        images.push({ type: 'image', data: (await readFile(path)).toString('base64'), mimeType });
      else files.push(path);
    }
    const message = files.length
      ? `${input.text}\n\nAttached files:\n${files.join('\n')}`
      : input.text;
    const { disposition } = await state.client.request<{ disposition?: string }>('prompt', {
      message,
      ...(images.length ? { images } : {}),
    });
    // Asked to stop before Pi had the prompt, and the abort found nothing to stop.
    if (state.interrupted && disposition !== 'handled') this.abort(state);
    return disposition !== 'handled';
  }

  async interruptTurn(id: string): Promise<void> {
    const state = this.require(id);
    if (!state.turn) return;
    state.interrupted = true;
    this.cancelPending(state);
    this.abort(state);
  }

  private abort(state: State): void {
    state.client
      .request('abort')
      .catch((error: unknown) => this.logger.warn('Pi abort failed', { error: String(error) }));
  }

  async listModels(id: string): Promise<ModelChoice[]> {
    return this.require(id).models.map((model) => ({
      id: piModelId(model),
      label: `${model.name ?? model.id} (${model.provider})`,
      options: {},
      imageInput: model.input?.includes('image') ?? null,
    }));
  }

  async setModel(id: string, model: ModelSelection): Promise<void> {
    const state = this.require(id);
    const choice = state.models.find((candidate) => piModelId(candidate) === model.id);
    if (!choice) throw new ProviderSessionError(PROVIDER, id, `Unavailable model: ${model.id}`);
    if (state.model === model.id) return;
    await state.client.request('set_model', { provider: choice.provider, modelId: choice.id });
    state.model = model.id;
  }

  async respondToRequest(id: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const state = this.require(id);
    const pending = state.pending.get(requestId);
    if (pending?.kind !== 'approval')
      throw new ProviderSessionError(PROVIDER, id, `No pending approval ${requestId}`);
    const response = pending.responses.get(decision);
    if (!response)
      throw new ProviderSessionError(PROVIDER, id, `Decision ${decision} is not offered`);
    state.pending.delete(requestId);
    if (decision === 'decline' && pending.toolCallId) state.declined.add(pending.toolCallId);
    state.client.respond(response);
    this.emit(state, { type: 'request.resolved', requestId, decision });
  }

  async respondToUserInput(
    id: string,
    requestId: string,
    answers: UserInputAnswers
  ): Promise<void> {
    const state = this.require(id);
    const pending = state.pending.get(requestId);
    if (pending?.kind !== 'question')
      throw new ProviderSessionError(PROVIDER, id, `No pending question ${requestId}`);
    const { question } = pending;
    const answer = answers[question.id];
    const values = Array.isArray(answer) ? answer : typeof answer === 'string' ? [answer] : [];
    const offered = values.every((value) =>
      question.options.some((option) => option.value === value)
    );
    // A question with no choices takes what was typed.
    const valid = question.allowCustomAnswer
      ? values.length === 1
      : offered && (question.multiSelect ? values.length > 0 : values.length === 1);
    if (!valid)
      throw new ProviderSessionError(
        PROVIDER,
        id,
        `Invalid answer for ${question.id}: choose one of the offered answers.`
      );
    state.pending.delete(requestId);
    state.client.respond(pending.answer(question.multiSelect ? values : values[0]!));
    this.emit(state, { type: 'user-input.resolved', requestId });
  }

  /** Whether a turn is running that has not been interrupted: the only time anyone can answer. */
  private activeTurn(state: State): string | null {
    return state.turn && !state.interrupted ? state.turn : null;
  }

  /** A request from an extension: Switch's own approvals and questions, or anyone else's dialog. */
  private dialog(state: State, request: PiUiRequest): void {
    const { method } = request;
    // notify, setStatus, setWidget and the like expect no answer.
    if (!['select', 'confirm', 'input', 'editor'].includes(method)) return;
    const turnId = this.activeTurn(state);
    if (!turnId) {
      state.client.respond(CANCEL(request.id));
      return;
    }
    const dialog = decodeDialog(request.title);
    if (
      dialog?.kind === 'approval' &&
      method === 'select' &&
      APPROVAL_OPTIONS.every((option, index) => request.options?.[index] === option)
    )
      this.approval(state, turnId, request, dialog);
    else if (method === 'confirm') this.confirmation(state, turnId, request);
    else this.question(state, turnId, request, dialog?.kind === 'question' ? dialog : undefined);
  }

  private approval(
    state: State,
    turnId: string,
    request: PiUiRequest,
    dialog: Extract<SwitchDialog, { kind: 'approval' }>
  ): void {
    const args = state.items.get(dialog.toolCallId)?.payload ?? {};
    const [once, session, reject] = APPROVAL_OPTIONS;
    const value = (choice: string): PiUiResponse => ({
      type: 'extension_ui_response',
      id: request.id,
      value: choice,
    });
    const { requestType, title, detail } = approvalContent(dialog, args);
    state.pending.set(request.id, {
      kind: 'approval',
      toolCallId: dialog.toolCallId,
      responses: new Map<ApprovalDecision, PiUiResponse>([
        ['accept', value(once)],
        ['acceptForSession', value(session)],
        ['decline', value(reject)],
        ['cancel', CANCEL(request.id)],
      ]),
    });
    this.emit(state, {
      type: 'request.opened',
      turnId,
      requestId: request.id,
      requestType,
      title,
      ...(detail === undefined ? {} : { detail }),
      options: [
        { decision: 'accept', label: once },
        { decision: 'acceptForSession', label: session },
        { decision: 'decline', label: reject },
        { decision: 'cancel', label: 'Cancel' },
      ],
      ...(dialog.connector ? { connector: dialog.server } : {}),
    });
  }

  /** Another extension's yes/no question, answered as a decision. */
  private confirmation(state: State, turnId: string, request: PiUiRequest): void {
    const confirmed = (value: boolean): PiUiResponse => ({
      type: 'extension_ui_response',
      id: request.id,
      confirmed: value,
    });
    state.pending.set(request.id, {
      kind: 'approval',
      responses: new Map<ApprovalDecision, PiUiResponse>([
        ['accept', confirmed(true)],
        ['decline', confirmed(false)],
        ['cancel', CANCEL(request.id)],
      ]),
    });
    this.emit(state, {
      type: 'request.opened',
      turnId,
      requestId: request.id,
      requestType: 'tool_approval',
      title: request.title ?? `${LABEL} needs a decision`,
      ...(request.message ? { detail: request.message } : {}),
      options: [
        { decision: 'accept', label: 'Approve' },
        { decision: 'decline', label: 'Decline' },
        { decision: 'cancel', label: 'Cancel' },
      ],
    });
  }

  /** `ask_user`'s question, or any extension's select, input or editor dialog. */
  private question(
    state: State,
    turnId: string,
    request: PiUiRequest,
    asked: Extract<SwitchDialog, { kind: 'question' }> | undefined
  ): void {
    const options = (request.options ?? []).map((label) => ({ label, value: label }));
    const multiSelect = asked?.multiSelect ?? false;
    const question: UserInputQuestion = {
      id: request.id,
      ...(asked?.header ? { header: asked.header } : {}),
      question: asked?.question ?? request.title ?? `${LABEL} has a question`,
      options,
      multiSelect,
      // A dialog with no choices asks for text.
      allowCustomAnswer: options.length === 0,
    };
    state.pending.set(request.id, {
      kind: 'question',
      question,
      // A multiple choice goes back as a JSON array, which `ask_user` reads.
      answer: (answer) => ({
        type: 'extension_ui_response',
        id: request.id,
        value: Array.isArray(answer) ? JSON.stringify(answer) : answer,
      }),
    });
    this.emit(state, {
      type: 'user-input.requested',
      turnId,
      requestId: request.id,
      questions: [question],
    });
  }

  private event(state: State, event: PiEvent): void {
    if (event.type === 'extension_error') {
      const message = `${event.extensionPath ?? 'An extension'} failed${event.event ? ` on ${event.event}` : ''}: ${event.error ?? 'unknown error'}`;
      if (state.starting) state.extensionErrors.push(message);
      else this.emit(state, { type: 'runtime.warning', message });
      return;
    }
    if (!state.turn) return;
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') {
          state.messageId = randomUUID();
          state.messageText = '';
        }
        break;
      case 'message_update':
        this.messageDelta(state, state.turn, event.assistantMessageEvent);
        break;
      case 'message_end':
        this.messageEnd(state, state.turn, event.message);
        break;
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
        this.tool(state, state.turn, event);
        break;
      case 'auto_retry_start':
        this.emit(state, {
          type: 'runtime.warning',
          message: `${LABEL} is retrying (${event.attempt} of ${event.maxAttempts})${event.errorMessage ? `: ${event.errorMessage}` : ''}`,
        });
        break;
      case 'auto_retry_end':
        if (!event.success)
          state.failure = event.finalError ?? state.failure ?? `${LABEL} gave up retrying.`;
        break;
      case 'agent_settled':
        this.settled(state, event.aborted === true);
        break;
    }
  }

  private messageDelta(
    state: State,
    turnId: string,
    update: { type: string; delta?: string }
  ): void {
    if (update.type !== 'text_delta' || !update.delta) return;
    if (!state.messageText) this.startMessage(state, turnId);
    state.messageText += update.delta;
    this.emit(state, {
      type: 'content.delta',
      turnId,
      itemId: state.messageId,
      delta: update.delta,
    });
  }

  private startMessage(state: State, turnId: string): void {
    this.emit(state, {
      type: 'item.started',
      turnId,
      item: {
        id: state.messageId,
        type: 'assistant_message',
        status: 'in_progress',
        title: '',
        text: '',
      },
    });
  }

  private messageEnd(state: State, turnId: string, message: PiMessage): void {
    if (message.role !== 'assistant') return;
    const text = textOf(message.content);
    if (text) {
      if (!state.messageText) this.startMessage(state, turnId);
      this.emit(state, {
        type: 'item.completed',
        turnId,
        item: {
          id: state.messageId,
          type: 'assistant_message',
          title: 'Assistant',
          status: message.stopReason === 'error' ? 'failed' : 'completed',
          text,
        },
      });
    }
    state.messageText = '';
    if (message.usage) this.addUsage(state, message);
    // An aborted response is the interrupt, not a failure.
    if (message.stopReason === 'error')
      state.failure = message.errorMessage ?? `${LABEL} stopped on an error.`;
    else if (message.stopReason !== 'aborted') state.failure = undefined;
  }

  private addUsage(state: State, message: PiMessage): void {
    const model = message.model
      ? `${message.provider ? `${message.provider}/` : ''}${message.model}`
      : '';
    const total = state.usage.get(model) ?? {
      model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    total.inputTokens += message.usage?.input ?? 0;
    total.outputTokens += message.usage?.output ?? 0;
    total.cacheReadTokens += message.usage?.cacheRead ?? 0;
    total.cacheWriteTokens += message.usage?.cacheWrite ?? 0;
    state.usage.set(model, total);
  }

  private tool(
    state: State,
    turnId: string,
    event: Extract<
      PiEvent,
      { type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end' }
    >
  ): void {
    const { toolCallId, toolName } = event;
    const old = state.items.get(toolCallId);
    const args = old?.payload ?? (event.type === 'tool_execution_end' ? {} : asRecord(event.args));
    const result =
      event.type === 'tool_execution_update'
        ? event.partialResult
        : event.type === 'tool_execution_end'
          ? event.result
          : undefined;
    const text = textOf(result?.content) || old?.text;
    const item: ProviderItem = {
      id: toolCallId,
      type: itemTypeFor(toolName),
      status:
        event.type !== 'tool_execution_end'
          ? 'in_progress'
          : state.declined.has(toolCallId)
            ? 'declined'
            : event.isError
              ? 'failed'
              : 'completed',
      title: old?.title ?? toolTitle(toolName, args),
      toolName: mcpTool(toolName)?.tool ?? toolName,
      payload: args,
      ...(text ? { text } : {}),
    };
    state.items.set(toolCallId, item);
    this.emit(state, {
      type:
        event.type === 'tool_execution_start'
          ? 'item.started'
          : event.type === 'tool_execution_update'
            ? 'item.updated'
            : 'item.completed',
      turnId,
      item,
    });
  }

  private settled(state: State, aborted: boolean): void {
    if (state.interrupted || aborted) this.complete(state, 'interrupted', 'Interrupted.');
    else if (state.failure) this.complete(state, 'error', state.failure);
    else this.complete(state, 'completed');
  }

  private complete(
    state: State,
    outcome: 'completed' | 'interrupted' | 'error',
    message?: string
  ): void {
    if (!state.turn) return;
    const turnId = state.turn;
    for (const item of state.items.values())
      if (item.status === 'in_progress') {
        if (outcome === 'completed') {
          outcome = 'error';
          message = `${LABEL} ended the turn without confirming a pending tool result.`;
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
    const usage = [...state.usage.values()];
    state.turn = null;
    this.emit(state, {
      type: 'turn.completed',
      turnId,
      outcome,
      ...(message ? { message } : {}),
      usage,
    });
    if (!state.turn)
      this.emit(state, {
        type: 'session.state.changed',
        status: state.stopping ? 'stopped' : outcome === 'error' ? 'error' : 'ready',
      });
    this.drain(state);
  }

  /** Cancels what is waiting on an answer; Pi blocks the tool call or ends the question. */
  private cancelPending(state: State): void {
    for (const [requestId, pending] of state.pending) {
      state.client.respond(CANCEL(requestId));
      this.emit(
        state,
        pending.kind === 'approval'
          ? { type: 'request.resolved', requestId, decision: 'cancel' }
          : { type: 'user-input.resolved', requestId }
      );
    }
    state.pending.clear();
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
    void rm(state.directory, { recursive: true, force: true });
    this.emit(state, { type: 'session.state.changed', status: 'stopped' });
    this.emit(state, { type: 'session.exited', reason });
  }

  private require(id: string): State {
    const state = this.sessions.get(id);
    if (!state || !state.client.isAlive)
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
        this.logger.error(`${LABEL} event listener failed`, { error: String(cause) });
      }
    }
  }
}

export function createPiAdapter(options: PiAdapterOptions = {}): PiAdapter {
  return new PiAdapter(options);
}
