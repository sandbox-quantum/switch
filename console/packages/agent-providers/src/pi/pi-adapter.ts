import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelChoice } from '@switch-console/shared/session-v1';
import {
  type ModelSelection,
  type ProviderAdapter,
  type ProviderCapabilities,
  ProviderConversationUnavailableError,
  type ProviderSendTurnInput,
  type ProviderSession,
  ProviderSessionError,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type TurnAttachment,
} from '../adapter';
import type {
  ApprovalDecision,
  ApprovalOption,
  ItemType,
  ProviderItem,
  ProviderRuntimeEvent,
  RequestType,
  TokenUsage,
  UserInputAnswers,
} from '../events';
import { signInWith } from '../readiness';
import { noopLogger, type ProviderLogger } from '../transport/stdio-json-rpc';
import {
  PI_APPROVAL_PREFIX,
  PI_EXTENSION_SOURCE,
  PI_SESSION_ENV,
  type PiApprovalAsk,
  type PiExtensionSession,
  piMcpServer,
} from './extension';
import { PiRpcClient, type PiRecord } from './rpc-client';

const PROVIDER = 'pi';

export const PI_LOGIN = '/login in pi';
export const PI_SIGN_IN_REQUIRED = signInWith(PI_LOGIN);

/** Pi's warning, on stderr, when `--session-id` names a session it then creates. */
const NO_SAVED_SESSION = 'No project session found with id';

const AUTO_MODE_WARNING =
  'Pi has no automatic review of its own, so auto mode asks before each action as approval-required does.';

const APPROVAL_OPTIONS: ApprovalOption[] = [
  { decision: 'accept', label: 'Allow once' },
  { decision: 'acceptForSession', label: 'Allow for the rest of this session' },
  { decision: 'decline', label: 'Deny' },
];

const REQUEST_TYPES: Record<PiApprovalAsk['kind'], RequestType> = {
  command: 'command_execution_approval',
  file: 'file_change_approval',
  mcp: 'mcp_tool_approval',
  tool: 'tool_approval',
};

const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

export interface PiAdapterOptions {
  /** Defaults to `pi` on PATH. */
  binaryPath?: string;
  logger?: ProviderLogger;
}

interface PendingApproval {
  uiId: string;
  toolCallId: string;
}

/** `Omit` collapses a union, so peel the metadata off each member instead. */
type EmittableEvent<T = ProviderRuntimeEvent> = T extends ProviderRuntimeEvent
  ? Omit<T, 'eventId' | 'provider' | 'sessionId' | 'createdAt'>
  : never;

interface StreamedItem {
  id: string;
  text: string;
}

interface PiSessionState {
  sessionId: string;
  nativeSessionId: string;
  client: PiRpcClient;
  /** Switch's own directory for the session: the extension and the system context. */
  dir: string;
  /** `provider/id` to run the next turn on, and the one Pi runs now. */
  model?: string;
  appliedModel?: string;
  /** The caller's id of the turn Pi is running, from `prompt` until `agent_settled`. */
  turnId?: string;
  turnStarted: boolean;
  message?: StreamedItem;
  reasoning?: StreamedItem;
  tools: Map<string, ProviderItem>;
  /** Tool calls the person declined, which Pi then reports as failed. */
  declined: Set<string>;
  approvals: Map<string, PendingApproval>;
  usage: TokenUsage[];
  /** The last assistant error in the running turn. */
  error?: string;
  compaction?: string;
  stopping: boolean;
  exited: boolean;
}

interface PiModel {
  id: string;
  name?: string;
  provider: string;
  input?: string[];
}

interface PiState {
  model?: PiModel;
  sessionId?: string;
  messageCount?: number;
}

interface PiContentBlock {
  type: string;
  text?: string;
}

interface PiAssistantMessage {
  role: string;
  content?: string | PiContentBlock[];
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

interface PiToolResult {
  content?: PiContentBlock[];
}

function textOf(content: string | PiContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

function toolItem(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>
): ProviderItem {
  let type: ItemType = 'tool_call';
  let title = toolName;
  if (toolName === 'bash' || toolName === 'powershell') {
    type = 'command_execution';
    title = String(args.command ?? toolName);
  } else if (toolName === 'edit' || toolName === 'write') {
    type = 'file_change';
    title = String(args.path ?? toolName);
  } else if (toolName.startsWith('mcp__')) {
    type = 'mcp_tool_call';
  }
  return { id: toolCallId, type, status: 'in_progress', title, toolName, payload: { args } };
}

function approvalTitle(ask: PiApprovalAsk): string {
  switch (ask.kind) {
    case 'command':
      return 'Pi wants to run a shell command.';
    case 'file':
      return ask.toolName === 'write' ? 'Pi wants to write a file.' : 'Pi wants to edit a file.';
    case 'mcp':
      return `Pi wants to call ${ask.toolName} on ${ask.server}.`;
    default:
      return `Pi wants to use ${ask.toolName}.`;
  }
}

/** The `provider` and `modelId` of a `provider/id` model, as `set_model` takes them. */
function splitModel(id: string): { provider: string; modelId: string } {
  const slash = id.indexOf('/');
  if (slash <= 0) throw new Error(`Pi models are named provider/id; "${id}" is not.`);
  return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

export class PiAdapter implements ProviderAdapter {
  readonly provider = PROVIDER;
  readonly capabilities: ProviderCapabilities = {
    modelSwitchInSession: true,
    steering: true,
    resume: true,
    approvals: true,
    userInput: false,
  };

  private readonly sessions = new Map<string, PiSessionState>();
  private readonly listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly binaryPath: string;
  private readonly logger: ProviderLogger;
  private requestSeq = 0;

  constructor(options: PiAdapterOptions = {}) {
    this.binaryPath = options.binaryPath ?? 'pi';
    this.logger = options.logger ?? noopLogger;
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
    // Pi opens the session with this id, or creates it: a fresh one gets an id
    // of Switch's own, which is also what a later start resumes it by.
    const nativeSessionId = input.resume?.nativeSessionId ?? `switch-${randomUUID()}`;
    const dir = await mkdtemp(join(tmpdir(), 'switch-pi-'));
    const extension = join(dir, 'switch-session.ts');
    await writeFile(extension, PI_EXTENSION_SOURCE, { mode: 0o600 });
    const args = [
      '--mode',
      'rpc',
      '--session-id',
      nativeSessionId,
      // Project-local `.pi` resources load executable code, which a session
      // must not pick up from whatever folder it was pointed at.
      '--no-approve',
      '-e',
      extension,
    ];
    if (input.systemContext) {
      const context = join(dir, 'switch-context.md');
      await writeFile(context, input.systemContext, { mode: 0o600 });
      args.push('--append-system-prompt', context);
    }
    if (input.model?.id) args.push('--model', input.model.id);
    const settings: PiExtensionSession = {
      runtimeMode: input.runtimeMode,
      mcpServers: Object.fromEntries(
        Object.entries(input.mcpServers).map(([name, spec]) => [name, piMcpServer(spec, input.env)])
      ),
      connectorMcpServers: input.connectorMcpServers,
    };

    const client: PiRpcClient = new PiRpcClient({
      command: this.binaryPath,
      args,
      cwd: input.cwd,
      env: { ...input.env, [PI_SESSION_ENV]: JSON.stringify(settings) },
      logger: this.logger,
      onRecord: (record) => {
        const owner = this.sessions.get(input.sessionId);
        if (owner?.client === client) this.handleRecord(owner, record);
      },
      onExit: (reason) => this.handleProcessExit(input.sessionId, reason),
    });
    const state: PiSessionState = {
      sessionId: input.sessionId,
      nativeSessionId,
      client,
      dir,
      ...(input.model?.id ? { model: input.model.id, appliedModel: input.model.id } : {}),
      turnStarted: false,
      tools: new Map(),
      declined: new Set(),
      approvals: new Map(),
      usage: [],
      stopping: false,
      exited: false,
    };
    this.sessions.set(input.sessionId, state);
    this.emit(state, { type: 'session.state.changed', status: 'starting' });

    try {
      const piState = await client.command<PiState>('get_state');
      if (!piState.model || piState.model.provider === 'unknown')
        throw new Error(PI_SIGN_IN_REQUIRED);
      if (!state.model) state.appliedModel = `${piState.model.provider}/${piState.model.id}`;
      if (input.resume && (client.stderr.includes(NO_SAVED_SESSION) || !piState.messageCount))
        throw new ProviderConversationUnavailableError(
          PROVIDER,
          input.sessionId,
          'The saved Pi conversation is unavailable. Start a fresh conversation to continue.'
        );
    } catch (cause) {
      if (this.sessions.get(input.sessionId) === state) this.sessions.delete(input.sessionId);
      await client
        .dispose()
        .catch((error: unknown) =>
          this.logger.warn('pi did not stop after a failed start', { error: String(error) })
        );
      await this.removeDir(dir);
      if (cause instanceof ProviderSessionError) throw cause;
      throw new ProviderSessionError(
        PROVIDER,
        input.sessionId,
        `could not start pi: ${cause instanceof Error ? cause.message : String(cause)}${
          client.stderr ? `\n${client.stderr}` : ''
        }`,
        { cause }
      );
    }

    this.emit(state, { type: 'session.started', nativeSessionId });
    if (input.runtimeMode === 'auto') {
      this.logger.warn(AUTO_MODE_WARNING, { sessionId: input.sessionId });
      this.emit(state, { type: 'runtime.warning', message: AUTO_MODE_WARNING });
    }
    this.emit(state, { type: 'session.state.changed', status: 'ready' });
    return { sessionId: input.sessionId, nativeSessionId, provider: PROVIDER };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    const state = this.requireSession(input.sessionId);
    if (input.model?.id) state.model = input.model.id;
    const message = await this.promptOf(input.text, input.attachments);

    if (state.turnId) {
      // A message mid-turn joins the running turn before Pi's next model call.
      const running = state.turnId;
      await state.client.command('steer', message);
      if (state.turnId === running) return { turnId: input.turnId, steeredInto: running };
      // Pi settled before it took the message, which then waits in its queue
      // with no run to read it: Pi writes records in order, so the settle was
      // read before this answer. Take it back and send it as a turn of its own.
      await state.client.command('clear_queue');
    }

    try {
      if (state.model && state.model !== state.appliedModel) {
        await state.client.command('set_model', splitModel(state.model));
        state.appliedModel = state.model;
      }
      this.beginTurn(state, input.turnId);
      const response = await state.client.command<{ disposition?: string }>('prompt', message);
      if (response?.disposition === 'handled') this.completeTurn(state, 'completed');
      else this.markTurnStarted(state);
      return { turnId: input.turnId };
    } catch (cause) {
      if (state.turnId === input.turnId) state.turnId = undefined;
      throw new ProviderSessionError(PROVIDER, input.sessionId, `prompt failed: ${String(cause)}`, {
        cause,
      });
    }
  }

  async interruptTurn(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    if (!state.turnId) return;
    // An approval Pi waits on would otherwise hold the abort until it is answered.
    this.cancelPending(state);
    await state.client.command('abort');
  }

  async respondToRequest(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    const state = this.requireSession(sessionId);
    const pending = state.approvals.get(requestId);
    if (!pending)
      throw new ProviderSessionError(PROVIDER, sessionId, `no open request ${requestId}`);
    state.approvals.delete(requestId);
    this.answer(state, pending, decision);
    this.emit(state, { type: 'request.resolved', requestId, decision });
  }

  async respondToUserInput(
    sessionId: string,
    requestId: string,
    _answers: UserInputAnswers
  ): Promise<void> {
    throw new ProviderSessionError(
      PROVIDER,
      sessionId,
      `pi asks no questions; no open question ${requestId}`
    );
  }

  async listModels(sessionId: string): Promise<ModelChoice[]> {
    const state = this.requireSession(sessionId);
    const { models } = await state.client.command<{ models: PiModel[] }>('get_available_models');
    return models.map((model) => ({
      id: `${model.provider}/${model.id}`,
      label: model.name ?? model.id,
      options: {},
      imageInput: model.input?.includes('image') ?? null,
    }));
  }

  async setModel(sessionId: string, model: ModelSelection): Promise<void> {
    const state = this.requireSession(sessionId);
    splitModel(model.id);
    state.model = model.id;
  }

  async stopSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.stopping = true;
    this.cancelPending(state);
    await state.client.dispose();
    await this.removeDir(state.dir);
    this.finishSession(state, 'stopped by Switch');
  }

  /**
   * On Windows, Pi's process tree can still hold the session's files for a
   * moment after the process it was started through exits.
   */
  private async removeDir(dir: string): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (cause) {
      this.logger.warn('could not remove the pi session directory', { dir, error: String(cause) });
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.stopSession(sessionId)));
  }

  /** The `prompt` fields for a turn: images inline, every other attachment named by its path. */
  private async promptOf(
    text: string,
    attachments: TurnAttachment[] | undefined
  ): Promise<{
    message: string;
    images?: Array<{ type: 'image'; data: string; mimeType: string }>;
  }> {
    const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
    const files: string[] = [];
    for (const attachment of attachments ?? []) {
      if (attachment.mimeType.startsWith('image/'))
        images.push({
          type: 'image',
          data: (await readFile(attachment.path)).toString('base64'),
          mimeType: attachment.mimeType,
        });
      else files.push(attachment.path);
    }
    const message =
      files.length === 0
        ? text
        : `${text}\n\nAttached files:\n${files.map((path) => `- ${path}`).join('\n')}`;
    return { message, ...(images.length > 0 ? { images } : {}) };
  }

  private beginTurn(state: PiSessionState, turnId: string): void {
    state.turnId = turnId;
    state.turnStarted = false;
    state.message = undefined;
    state.reasoning = undefined;
    state.tools.clear();
    state.declined.clear();
    state.usage = [];
    state.error = undefined;
  }

  private markTurnStarted(state: PiSessionState): void {
    if (!state.turnId || state.turnStarted) return;
    state.turnStarted = true;
    this.emit(state, { type: 'turn.started', turnId: state.turnId });
    this.emit(state, { type: 'session.state.changed', status: 'running' });
  }

  private completeTurn(
    state: PiSessionState,
    outcome: 'completed' | 'interrupted' | 'error',
    message?: string
  ): void {
    const turnId = state.turnId;
    if (!turnId) return;
    this.markTurnStarted(state);
    this.finishStreamed(state, outcome === 'completed' ? 'completed' : 'failed');
    for (const item of state.tools.values())
      this.emit(state, { type: 'item.completed', turnId, item: { ...item, status: 'failed' } });
    state.tools.clear();
    state.turnId = undefined;
    const usage = state.usage;
    state.usage = [];
    this.emit(state, {
      type: 'turn.completed',
      turnId,
      outcome,
      ...(message ? { message } : {}),
      usage,
    });
    if (!state.exited) this.emit(state, { type: 'session.state.changed', status: 'ready' });
  }

  private handleRecord(state: PiSessionState, record: PiRecord): void {
    if (record.type === 'extension_ui_request') {
      this.handleUiRequest(state, record);
      return;
    }
    if (record.type === 'extension_error') {
      this.emit(state, {
        type: 'runtime.error',
        message: `A Pi extension failed in ${String(record.event)}: ${String(record.error)}`,
      });
      return;
    }
    const turnId = state.turnId;
    if (!turnId) return;
    switch (record.type) {
      case 'agent_start':
        this.markTurnStarted(state);
        return;
      case 'message_update':
        this.handleMessageUpdate(
          state,
          turnId,
          record.assistantMessageEvent as Record<string, unknown>
        );
        return;
      case 'message_end':
        this.handleMessageEnd(state, record.message as PiAssistantMessage);
        return;
      case 'tool_execution_start': {
        this.finishStreamed(state, 'completed');
        const item = toolItem(
          String(record.toolCallId),
          String(record.toolName),
          (record.args as Record<string, unknown>) ?? {}
        );
        state.tools.set(item.id, item);
        this.emit(state, { type: 'item.started', turnId, item });
        return;
      }
      case 'tool_execution_update': {
        const item = state.tools.get(String(record.toolCallId));
        if (!item) return;
        const text = textOf((record.partialResult as PiToolResult | undefined)?.content);
        if (!text) return;
        const updated = { ...item, text };
        state.tools.set(item.id, updated);
        this.emit(state, { type: 'item.updated', turnId, item: updated });
        return;
      }
      case 'tool_execution_end': {
        const id = String(record.toolCallId);
        const item = state.tools.get(id) ?? toolItem(id, String(record.toolName), {});
        state.tools.delete(id);
        const text = textOf((record.result as PiToolResult | undefined)?.content);
        this.emit(state, {
          type: 'item.completed',
          turnId,
          item: {
            ...item,
            status: state.declined.has(id) ? 'declined' : record.isError ? 'failed' : 'completed',
            ...(text ? { text } : {}),
          },
        });
        return;
      }
      case 'compaction_start': {
        state.compaction = `pi-compaction-${randomUUID().slice(0, 8)}`;
        this.emit(state, {
          type: 'item.started',
          turnId,
          item: {
            id: state.compaction,
            type: 'context_compaction',
            status: 'in_progress',
            title: 'Compacting the conversation',
          },
        });
        return;
      }
      case 'compaction_end': {
        if (!state.compaction) return;
        const failed = !record.result;
        this.emit(state, {
          type: 'item.completed',
          turnId,
          item: {
            id: state.compaction,
            type: 'context_compaction',
            status: failed ? 'failed' : 'completed',
            title: 'Compacting the conversation',
            ...(record.errorMessage ? { text: String(record.errorMessage) } : {}),
          },
        });
        state.compaction = undefined;
        return;
      }
      case 'auto_retry_start':
        this.emit(state, {
          type: 'runtime.warning',
          message: `Pi is retrying the model call (attempt ${String(record.attempt)} of ${String(record.maxAttempts)}): ${String(record.errorMessage)}`,
        });
        return;
      case 'agent_settled':
        if (record.aborted === true) this.completeTurn(state, 'interrupted');
        else if (state.error) this.completeTurn(state, 'error', state.error);
        else this.completeTurn(state, 'completed');
        return;
    }
  }

  private handleMessageUpdate(
    state: PiSessionState,
    turnId: string,
    update: Record<string, unknown> | undefined
  ): void {
    if (!update || typeof update.delta !== 'string' || update.delta === '') return;
    if (update.type === 'text_delta') {
      if (!state.message) {
        state.message = { id: `pi-msg-${randomUUID().slice(0, 8)}`, text: '' };
        this.emit(state, {
          type: 'item.started',
          turnId,
          item: {
            id: state.message.id,
            type: 'assistant_message',
            status: 'in_progress',
            title: '',
            text: '',
          },
        });
      }
      state.message.text += update.delta;
      this.emit(state, {
        type: 'content.delta',
        turnId,
        itemId: state.message.id,
        delta: update.delta,
      });
    } else if (update.type === 'thinking_delta') {
      if (!state.reasoning) {
        state.reasoning = { id: `pi-think-${randomUUID().slice(0, 8)}`, text: '' };
        this.emit(state, {
          type: 'item.started',
          turnId,
          item: {
            id: state.reasoning.id,
            type: 'reasoning',
            status: 'in_progress',
            title: 'Thinking',
          },
        });
      }
      state.reasoning.text += update.delta;
      this.emit(state, {
        type: 'item.delta',
        turnId,
        itemId: state.reasoning.id,
        delta: update.delta,
      });
    }
  }

  private handleMessageEnd(state: PiSessionState, message: PiAssistantMessage | undefined): void {
    if (!message || message.role !== 'assistant') return;
    // The final message is authoritative over the streamed deltas.
    if (state.message) state.message.text = textOf(message.content) || state.message.text;
    this.finishStreamed(state, message.stopReason === 'error' ? 'failed' : 'completed');
    // The turn ends as its last model response did: Pi retries a failed call
    // itself, and one that then succeeds leaves the turn completed.
    state.error =
      message.stopReason === 'error'
        ? (message.errorMessage ?? 'Pi reported a model error.')
        : undefined;
    const usage = message.usage;
    if (usage)
      state.usage.push({
        model:
          message.provider && message.model
            ? `${message.provider}/${message.model}`
            : (message.model ?? ''),
        inputTokens: usage.input ?? 0,
        outputTokens: usage.output ?? 0,
        cacheReadTokens: usage.cacheRead ?? 0,
        cacheWriteTokens: usage.cacheWrite ?? 0,
      });
  }

  /** Completes the assistant message and reasoning streamed so far in the turn. */
  private finishStreamed(state: PiSessionState, status: 'completed' | 'failed'): void {
    const turnId = state.turnId;
    if (!turnId) return;
    if (state.reasoning) {
      this.emit(state, {
        type: 'item.completed',
        turnId,
        item: {
          id: state.reasoning.id,
          type: 'reasoning',
          status,
          title: 'Thinking',
          text: state.reasoning.text,
        },
      });
      state.reasoning = undefined;
    }
    if (state.message) {
      this.emit(state, {
        type: 'item.completed',
        turnId,
        item: {
          id: state.message.id,
          type: 'assistant_message',
          status,
          title: 'Assistant',
          text: state.message.text,
        },
      });
      state.message = undefined;
    }
  }

  private handleUiRequest(state: PiSessionState, record: PiRecord): void {
    const method = String(record.method);
    const title = typeof record.title === 'string' ? record.title : '';
    if (method === 'select' && title.startsWith(PI_APPROVAL_PREFIX)) {
      this.openApproval(
        state,
        String(record.id),
        JSON.parse(title.slice(PI_APPROVAL_PREFIX.length)) as PiApprovalAsk
      );
      return;
    }
    if (DIALOG_METHODS.has(method)) {
      // A dialog from one of the person's own Pi extensions: there is no one
      // at a terminal to answer it, so it is dismissed and said.
      state.client.send({ type: 'extension_ui_response', id: String(record.id), cancelled: true });
      this.emit(state, {
        type: 'runtime.warning',
        message: `A Pi extension asked "${title || method}", which Switch cannot show, so it was dismissed.`,
      });
      return;
    }
    if (method === 'notify' && (record.notifyType === 'warning' || record.notifyType === 'error'))
      this.emit(state, { type: 'runtime.warning', message: String(record.message ?? '') });
  }

  private openApproval(state: PiSessionState, uiId: string, ask: PiApprovalAsk): void {
    const requestId = `pi-req-${++this.requestSeq}-${randomUUID().slice(0, 8)}`;
    const turnId = state.turnId;
    if (!turnId) {
      this.answer(state, { uiId, toolCallId: ask.toolCallId }, 'decline');
      return;
    }
    state.approvals.set(requestId, { uiId, toolCallId: ask.toolCallId });
    this.emit(state, {
      type: 'request.opened',
      turnId,
      requestId,
      requestType: REQUEST_TYPES[ask.kind],
      title: approvalTitle(ask),
      ...(ask.detail ? { detail: ask.detail } : {}),
      options: APPROVAL_OPTIONS,
      ...(ask.kind === 'mcp' && ask.server ? { connector: ask.server } : {}),
    });
  }

  private answer(
    state: PiSessionState,
    pending: PendingApproval,
    decision: ApprovalDecision
  ): void {
    if (decision === 'accept' || decision === 'acceptForSession') {
      state.client.send({ type: 'extension_ui_response', id: pending.uiId, value: decision });
      return;
    }
    state.declined.add(pending.toolCallId);
    state.client.send(
      decision === 'cancel'
        ? { type: 'extension_ui_response', id: pending.uiId, cancelled: true }
        : { type: 'extension_ui_response', id: pending.uiId, value: 'decline' }
    );
  }

  private cancelPending(state: PiSessionState): void {
    for (const [requestId, pending] of [...state.approvals]) {
      state.approvals.delete(requestId);
      this.answer(state, pending, 'cancel');
      this.emit(state, { type: 'request.resolved', requestId, decision: 'cancel' });
    }
  }

  private handleProcessExit(sessionId: string, reason: string): void {
    const state = this.sessions.get(sessionId);
    // A stop Switch asked for finishes the session itself, once pi is gone.
    if (!state || state.stopping) return;
    for (const [requestId] of [...state.approvals]) {
      state.approvals.delete(requestId);
      this.emit(state, { type: 'request.resolved', requestId, decision: 'cancel' });
    }
    void this.removeDir(state.dir);
    this.finishSession(state, reason);
  }

  private finishSession(state: PiSessionState, reason: string): void {
    if (state.exited) return;
    state.exited = true;
    this.sessions.delete(state.sessionId);
    if (state.turnId) this.completeTurn(state, state.stopping ? 'interrupted' : 'error', reason);
    this.emit(state, { type: 'session.state.changed', status: 'stopped' });
    this.emit(state, { type: 'session.exited', reason });
  }

  private requireSession(sessionId: string): PiSessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new ProviderSessionError(PROVIDER, sessionId, 'unknown or stopped session');
    if (!state.client.isAlive) {
      throw new ProviderSessionError(PROVIDER, sessionId, 'pi is no longer running');
    }
    return state;
  }

  private emit(state: PiSessionState, event: EmittableEvent): void {
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
        this.logger.error('pi event listener threw', { error: String(cause) });
      }
    }
  }
}

export function createPiAdapter(options: PiAdapterOptions = {}): PiAdapter {
  return new PiAdapter(options);
}
