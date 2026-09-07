import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type {
  ModelSelection,
  ProviderAdapter,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '../adapter';
import { ProviderSessionError } from '../adapter';
import type {
  ApprovalDecision,
  ProviderItem,
  ProviderRuntimeEvent,
  UserInputAnswers,
} from '../events';
import {
  StdioJsonRpcClient,
  JsonRpcError,
  noopLogger,
  type ProviderLogger,
} from '../transport/stdio-json-rpc';
import { protectGeminiRollout } from './resume';

interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}
interface ToolUpdate {
  sessionUpdate: string;
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: Array<{
    type: string;
    content?: { type: string; text?: string };
    path?: string;
    oldText?: string;
    newText?: string;
  }>;
}
interface Update extends Omit<ToolUpdate, 'content'> {
  content?: ToolUpdate['content'] | { type: string; text?: string };
}
interface State {
  id: string;
  nativeId: string;
  client: StdioJsonRpcClient;
  turn: string | null;
  queue: ProviderSendTurnInput[];
  items: Map<string, ProviderItem>;
  approvals: Map<
    string,
    { options: Map<ApprovalDecision, string>; settle: (value: unknown) => void }
  >;
  messageId: string;
  messageText: string;
  stopping: boolean;
  interrupted: boolean;
  context: string;
}

type Emittable<T = ProviderRuntimeEvent> = T extends ProviderRuntimeEvent
  ? Omit<T, 'eventId' | 'provider' | 'sessionId' | 'createdAt'>
  : never;

export interface GeminiAdapterOptions {
  binaryPath?: string;
  logger?: ProviderLogger;
}

export class GeminiAdapter implements ProviderAdapter {
  readonly provider = 'gemini';
  readonly capabilities = {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  };
  private readonly sessions = new Map<string, State>();
  private readonly listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly logger: ProviderLogger;
  constructor(private readonly options: GeminiAdapterOptions = {}) {
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
      throw new ProviderSessionError('gemini', input.sessionId, 'session already started');
    const cwd = await realpath(input.cwd);
    const client = new StdioJsonRpcClient({
      command: this.options.binaryPath ?? 'gemini',
      args: [
        '--acp',
        '--approval-mode',
        input.runtimeMode === 'full-access'
          ? 'yolo'
          : input.runtimeMode === 'auto-accept-edits'
            ? 'auto_edit'
            : 'default',
        ...(input.model ? ['--model', input.model.id] : []),
      ],
      cwd,
      env: { ...input.env, GEMINI_CLI_NO_RELAUNCH: '1', GEMINI_CLI_TRUST_WORKSPACE: 'true' },
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
      approvals: new Map(),
      messageId: '',
      messageText: '',
      stopping: false,
      interrupted: false,
      context: input.systemContext ?? '',
    };
    this.sessions.set(state.id, state);
    client.onNotification('session/update', (params) => {
      const payload = params as { sessionId: string; update: Update };
      if (payload.sessionId === state.nativeId) this.update(state, payload.update);
    });
    client.onServerRequest('session/request_permission', (params) =>
      this.permission(
        state,
        params as { sessionId: string; toolCall: ToolUpdate; options: PermissionOption[] }
      )
    );
    this.emit(state, { type: 'session.state.changed', status: 'starting' });
    try {
      const initialized = await client.request<{
        agentInfo?: { version: string };
        agentCapabilities?: { loadSession?: boolean };
      }>('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'switch-console', version: '0.1.0' },
        clientCapabilities: {},
      });
      const mcpServers = Object.entries(input.mcpServers).map(([name, server]) =>
        server.transport === 'stdio'
          ? {
              name,
              command: server.command,
              args: server.args,
              env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
            }
          : {
              name,
              type: 'http',
              url: server.url,
              headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({
                name,
                value,
              })),
            }
      );
      if (input.resume && !initialized.agentCapabilities?.loadSession)
        throw new Error('This Gemini CLI does not support session resume.');
      if (
        input.resume &&
        input.env.GEMINI_CLI_HOME &&
        initialized.agentInfo?.version === '0.58.0'
      ) {
        await protectGeminiRollout(input.env.GEMINI_CLI_HOME, input.resume.nativeSessionId);
      }
      state.nativeId = input.resume?.nativeSessionId ?? '';
      const result = await client.request<{ sessionId?: string }>(
        input.resume ? 'session/load' : 'session/new',
        { cwd, mcpServers, ...(input.resume ? { sessionId: input.resume.nativeSessionId } : {}) }
      );
      state.nativeId = result.sessionId ?? state.nativeId;
      if (!state.nativeId) throw new Error('Gemini returned no session ID.');
      await client.request('session/set_mode', {
        sessionId: state.nativeId,
        modeId:
          input.runtimeMode === 'full-access'
            ? 'yolo'
            : input.runtimeMode === 'auto-accept-edits'
              ? 'autoEdit'
              : 'default',
      });
      if (input.resume && input.model) await this.setModel(state.id, input.model);
      this.emit(state, { type: 'session.started', nativeSessionId: state.nativeId });
      this.emit(state, { type: 'session.state.changed', status: 'ready' });
      return { provider: 'gemini', sessionId: state.id, nativeSessionId: state.nativeId };
    } catch (cause) {
      client.dispose();
      this.sessions.delete(state.id);
      const details =
        cause instanceof JsonRpcError &&
        typeof cause.data === 'object' &&
        cause.data !== null &&
        'details' in cause.data
          ? String(cause.data.details)
          : '';
      throw new ProviderSessionError(
        'gemini',
        state.id,
        `Could not start Gemini ACP: ${String(cause)}${details ? `: ${details}` : ''}${client.stderr ? `\n${client.stderr}` : ''}`,
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
              : `Gemini stopped: ${reason}`
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
      if (attachment.mimeType.startsWith('image/') || attachment.mimeType.startsWith('audio/')) {
        prompt.push({
          type: attachment.mimeType.startsWith('image/') ? 'image' : 'audio',
          data: (await readFile(attachment.path)).toString('base64'),
          mimeType: attachment.mimeType,
        });
      } else {
        prompt.push({
          type: 'resource',
          resource: {
            uri: pathToFileURL(attachment.path).href,
            mimeType: attachment.mimeType,
            ...(attachment.mimeType.startsWith('text/') || /json|xml/.test(attachment.mimeType)
              ? { text: await readFile(attachment.path, 'utf8') }
              : { blob: (await readFile(attachment.path)).toString('base64') }),
          },
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
    this.cancelApprovals(state);
  }

  async setModel(id: string, model: ModelSelection): Promise<void> {
    const state = this.require(id);
    await state.client.request('session/set_model', {
      sessionId: state.nativeId,
      modelId: model.id,
    });
  }

  async respondToRequest(id: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const state = this.require(id);
    const pending = state.approvals.get(requestId);
    if (!pending) throw new ProviderSessionError('gemini', id, `No pending approval ${requestId}`);
    const optionId = pending.options.get(decision);
    if (!optionId && decision !== 'cancel' && decision !== 'decline')
      throw new ProviderSessionError('gemini', id, `Decision ${decision} is not offered`);
    state.approvals.delete(requestId);
    pending.settle({
      outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
    });
    this.emit(state, { type: 'request.resolved', requestId, decision });
  }

  async respondToUserInput(
    id: string,
    _requestId: string,
    _answers: UserInputAnswers
  ): Promise<void> {
    throw new ProviderSessionError(
      'gemini',
      id,
      'Gemini ACP does not expose structured question answers; answer in the conversation.'
    );
  }

  private async permission(
    state: State,
    params: { sessionId: string; toolCall: ToolUpdate; options: PermissionOption[] }
  ): Promise<unknown> {
    if (params.sessionId !== state.nativeId || !state.turn || state.interrupted)
      return { outcome: { outcome: 'cancelled' } };
    const turnId = state.turn;
    const requestId = randomUUID();
    const options = new Map<ApprovalDecision, string>();
    const offered: Array<{ decision: ApprovalDecision; label: string }> = [];
    for (const option of params.options) {
      if (!['allow_once', 'allow_always', 'reject_once'].includes(option.kind)) continue;
      const decision =
        option.kind === 'allow_once'
          ? 'accept'
          : option.kind === 'allow_always'
            ? 'acceptForSession'
            : 'decline';
      // Permanent policies are intentionally not offered by this session UI.
      if (options.has(decision) || /future|permanent/i.test(option.name)) continue;
      options.set(decision, option.optionId);
      offered.push({ decision, label: option.name });
    }
    offered.push({ decision: 'cancel', label: 'Cancel' });
    return new Promise((settle) => {
      state.approvals.set(requestId, { options, settle });
      this.emit(state, {
        type: 'request.opened',
        turnId,
        requestId,
        requestType:
          params.toolCall.kind === 'execute'
            ? 'command_execution_approval'
            : params.toolCall.kind === 'edit'
              ? 'file_change_approval'
              : 'tool_approval',
        title: params.toolCall.title ?? 'Gemini needs permission',
        options: offered,
      });
    });
  }

  private update(state: State, update: Update): void {
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
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const old = state.items.get(update.toolCallId);
      const content = Array.isArray(update.content) ? update.content : [];
      const text = content
        .map((part) =>
          part.type === 'diff' ? `${part.path}\n${part.newText ?? ''}` : (part.content?.text ?? '')
        )
        .join('\n');
      const item: ProviderItem = {
        id: update.toolCallId,
        type:
          old?.type ??
          (update.toolCallId.startsWith('mcp_')
            ? 'mcp_tool_call'
            : update.kind === 'execute'
              ? 'command_execution'
              : update.kind === 'edit'
                ? 'file_change'
                : 'tool_call'),
        title: update.title ?? old?.title ?? 'Tool',
        status:
          update.status === 'completed'
            ? 'completed'
            : update.status === 'failed'
              ? 'failed'
              : (old?.status ?? 'in_progress'),
        ...(text || old?.text ? { text: text || old?.text } : {}),
      };
      state.items.set(item.id, item);
      this.emit(state, {
        type:
          item.status === 'completed' || item.status === 'failed'
            ? 'item.completed'
            : old
              ? 'item.updated'
              : 'item.started',
        turnId: state.turn,
        item,
      });
      this.finishMessage(state, 'completed');
      state.messageId = randomUUID();
    }
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
          message = 'Gemini ended the turn without confirming a pending tool result.';
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
    this.cancelApprovals(state);
    state.turn = null;
    this.emit(state, { type: 'turn.completed', turnId, outcome, ...(message ? { message } : {}) });
    if (!state.turn)
      this.emit(state, {
        type: 'session.state.changed',
        status: state.stopping ? 'stopped' : outcome === 'error' ? 'error' : 'ready',
      });
    this.drain(state);
  }

  private cancelApprovals(state: State): void {
    for (const [requestId, pending] of state.approvals) {
      pending.settle({ outcome: { outcome: 'cancelled' } });
      this.emit(state, { type: 'request.resolved', requestId, decision: 'cancel' });
    }
    state.approvals.clear();
  }
  async stopSession(id: string): Promise<void> {
    const state = this.sessions.get(id);
    if (!state) return;
    state.stopping = true;
    if (state.turn) await this.interruptTurn(id);
    state.client.dispose();
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
    this.cancelApprovals(state);
    for (const input of state.queue.splice(0))
      this.emit(state, {
        type: 'turn.completed',
        turnId: input.turnId,
        outcome: 'error',
        message: reason,
      });
    this.sessions.delete(id);
    this.emit(state, { type: 'session.state.changed', status: 'stopped' });
    this.emit(state, { type: 'session.exited', reason });
  }
  private require(id: string): State {
    const state = this.sessions.get(id);
    if (!state || !state.client.isAlive)
      throw new ProviderSessionError('gemini', id, 'Session is not running');
    return state;
  }
  private emit(state: State, event: Emittable): void {
    const full = {
      ...event,
      eventId: randomUUID(),
      provider: 'gemini',
      sessionId: state.id,
      createdAt: new Date().toISOString(),
    } as ProviderRuntimeEvent;
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch (cause) {
        this.logger.error('Gemini event listener failed', { error: String(cause) });
      }
    }
  }
}
export function createGeminiAdapter(options: GeminiAdapterOptions = {}): GeminiAdapter {
  return new GeminiAdapter(options);
}
