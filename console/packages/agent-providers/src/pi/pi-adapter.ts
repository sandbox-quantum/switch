import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelChoice } from '@switch-console/shared/session-v1';
import {
  ProviderConversationUnavailableError,
  ProviderSessionError,
  type ModelSelection,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
} from '../adapter';
import type {
  ApprovalDecision,
  ItemType,
  ProviderItem,
  ProviderRuntimeEvent,
  RequestType,
  TokenUsage,
} from '../events';
import { noopLogger, type ProviderLogger } from '../transport/stdio-json-rpc';
import { PiRpcClient, type PiRecord, type PiUiRequest } from './pi-rpc';
import {
  PI_APPROVAL_OPTIONS,
  PI_APPROVAL_STATUS,
  PI_SWITCH_EXTENSION,
  type PiExtensionConfig,
} from './switch-extension';

export interface PiAdapterOptions {
  binaryPath?: string;
  logger?: ProviderLogger;
}

interface PiModel {
  id: string;
  name?: string;
  provider: string;
  input?: string[];
}
interface PiState {
  sessionId: string;
  model?: PiModel;
  messageCount: number;
}
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}
interface PiMessage {
  role: string;
  content?: unknown;
  model?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
}
interface PiToolResult {
  content?: Array<{ type: string; text?: string }>;
}

interface State {
  id: string;
  nativeId: string;
  client: PiRpcClient;
  /** The session's own folder: the extension, its settings and the system context. */
  dir: string;
  turn: string | null;
  queue: ProviderSendTurnInput[];
  interrupted: boolean;
  stopping: boolean;
  /** Items of the running turn, by id. */
  items: Map<string, ProviderItem>;
  messages: number;
  message: { id: string; text: string; started: boolean } | null;
  reasoning: { id: string; text: string } | null;
  usage: Map<string, TokenUsage>;
  error: string | undefined;
  /** The tool call the extension's next approval dialog is about. */
  asking: { toolCallId: string; toolName: string; input: Record<string, unknown> } | null;
  approvals: Map<string, { uiId: string; toolCallId: string }>;
  declined: Set<string>;
  model: string | undefined;
  connectors: Set<string>;
}

type Emittable<T = ProviderRuntimeEvent> = T extends ProviderRuntimeEvent
  ? Omit<T, 'eventId' | 'provider' | 'sessionId' | 'createdAt'>
  : never;

/** `provider/model`, the id Switch stores for a Pi model. */
const modelKey = (model: PiModel | undefined) =>
  model ? `${model.provider}/${model.id}` : undefined;

/** Pi names an MCP tool `mcp__<server>__<tool>`. */
export function piMcpTool(toolName: string): { server: string; tool: string } | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  const end = toolName.indexOf('__', 5);
  return end > 5 ? { server: toolName.slice(5, end), tool: toolName.slice(end + 2) } : undefined;
}

function itemType(toolName: string): ItemType {
  if (toolName === 'bash') return 'command_execution';
  if (toolName === 'edit' || toolName === 'write') return 'file_change';
  return piMcpTool(toolName) ? 'mcp_tool_call' : 'tool_call';
}

function requestType(toolName: string): RequestType {
  if (toolName === 'bash') return 'command_execution_approval';
  if (toolName === 'edit' || toolName === 'write') return 'file_change_approval';
  return piMcpTool(toolName) ? 'mcp_tool_approval' : 'tool_approval';
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

function toolTitle(toolName: string, args: Record<string, unknown>): string {
  return (
    (toolName === 'bash' ? text(args.command) : undefined) ??
    (['read', 'edit', 'write'].includes(toolName) ? text(args.path) : undefined) ??
    toolName
  );
}

function resultText(result: unknown): string {
  return ((result as PiToolResult | undefined)?.content ?? [])
    .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

function blocks(message: PiMessage, type: 'text' | 'thinking'): string {
  if (typeof message.content === 'string') return type === 'text' ? message.content : '';
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part: { type?: string; text?: string; thinking?: string }) =>
      part.type === type ? (type === 'text' ? part.text : part.thinking) : ''
    )
    .filter(Boolean)
    .join('');
}

/** What the session's extension is told: its runtime mode and its MCP servers in Pi's shape. */
export function piExtensionConfig(input: ProviderSessionStartInput): PiExtensionConfig {
  const names = Object.keys(input.mcpServers);
  return {
    runtimeMode: input.runtimeMode,
    mcpServers: Object.fromEntries(
      Object.entries(input.mcpServers).map(([name, server]) => [
        name,
        server.transport === 'stdio'
          ? {
              command: server.command,
              args: server.args,
              env: {
                ...Object.fromEntries(
                  (server.envVars ?? [])
                    .filter((key) => input.env[key] !== undefined)
                    .map((key) => [key, input.env[key]])
                ),
                ...server.env,
              },
            }
          : { url: server.url, headers: server.headers ?? {} },
      ])
    ),
    autoApproved: names.filter((name) => !input.connectorMcpServers.includes(name)),
  };
}

/**
 * Pi's own RPC mode (`pi --mode rpc`), one process per session. Pi has no
 * permission prompts and its ACP bridge passes no MCP servers through, so each
 * session loads a small extension of Switch's (`switch-extension.ts`) that
 * registers the session's MCP servers and asks before tools run.
 */
export class PiAdapter implements ProviderAdapter {
  readonly provider = 'pi';
  readonly capabilities: ProviderCapabilities = {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  };
  private readonly sessions = new Map<string, State>();
  private readonly listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly logger: ProviderLogger;

  constructor(private readonly options: PiAdapterOptions = {}) {
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
    if (this.sessions.has(input.sessionId))
      throw new ProviderSessionError(this.provider, input.sessionId, 'session already started');
    const dir = await mkdtemp(join(tmpdir(), 'switch-pi-'));
    const settings = join(dir, 'session.json');
    const args = ['--mode', 'rpc', '--session-id', input.resume?.nativeSessionId ?? randomUUID()];
    try {
      const extension = join(dir, 'switch-extension.js');
      await writeFile(extension, PI_SWITCH_EXTENSION);
      // The MCP servers' bearer tokens are in it, so it is private to this
      // user and removed as soon as the extension has read it.
      await writeFile(settings, JSON.stringify(piExtensionConfig(input)), { mode: 0o600 });
      args.push('-e', extension);
      if (input.systemContext) {
        const context = join(dir, 'switch-context.md');
        await writeFile(context, input.systemContext);
        args.push('--append-system-prompt', context);
      }
      if (input.model) args.push('--model', input.model.id);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    // Pi's records arrive only after this returns, by which time `state` is set.
    const client = new PiRpcClient({
      command: this.options.binaryPath ?? 'pi',
      args,
      cwd: input.cwd,
      env: { ...input.env, SWITCH_PI_CONFIG: settings },
      logger: this.logger,
      onEvent: (event) => this.event(state, event),
      onUiRequest: (request) => this.ui(state, request),
      onExit: (reason) => this.exited(state.id, reason),
    });
    const state: State = {
      id: input.sessionId,
      nativeId: '',
      client,
      dir,
      turn: null,
      queue: [],
      interrupted: false,
      stopping: false,
      items: new Map(),
      messages: 0,
      message: null,
      reasoning: null,
      usage: new Map(),
      error: undefined,
      asking: null,
      approvals: new Map(),
      declined: new Set(),
      model: undefined,
      connectors: new Set(input.connectorMcpServers),
    };
    this.sessions.set(state.id, state);
    this.emit(state, { type: 'session.state.changed', status: 'starting' });
    try {
      // Pi answers once its extensions have loaded, so the settings file has
      // been read by then.
      const status = await state.client.request<PiState>('get_state');
      await rm(settings, { force: true });
      if (input.resume && !status.messageCount)
        throw new ProviderConversationUnavailableError(
          this.provider,
          state.id,
          'Pi has no saved conversation with this id in this folder. Start a fresh conversation; the existing transcript is preserved.'
        );
      state.nativeId = status.sessionId;
      state.model = modelKey(status.model);
      this.emit(state, { type: 'session.started', nativeSessionId: state.nativeId });
      this.emit(state, { type: 'session.state.changed', status: 'ready' });
      return { provider: this.provider, sessionId: state.id, nativeSessionId: state.nativeId };
    } catch (cause) {
      this.sessions.delete(state.id);
      await state.client.dispose().catch(() => {});
      await rm(dir, { recursive: true, force: true });
      if (cause instanceof ProviderConversationUnavailableError) throw cause;
      throw new ProviderSessionError(
        this.provider,
        state.id,
        `Could not start Pi: ${String(cause)}${state.client.stderr ? `\n${state.client.stderr}` : ''}`,
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

  async interruptTurn(id: string): Promise<void> {
    const state = this.require(id);
    if (!state.turn) return;
    state.interrupted = true;
    this.cancelPending(state);
    await state.client.request('abort');
  }

  async respondToRequest(id: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const state = this.require(id);
    const pending = state.approvals.get(requestId);
    if (!pending)
      throw new ProviderSessionError(this.provider, id, `No pending approval ${requestId}`);
    state.approvals.delete(requestId);
    if (decision === 'decline' || decision === 'cancel') state.declined.add(pending.toolCallId);
    state.client.respondToUi(
      pending.uiId,
      decision === 'cancel' ? { cancelled: true } : { value: PI_APPROVAL_OPTIONS[decision] }
    );
    this.emit(state, { type: 'request.resolved', requestId, decision });
  }

  async respondToUserInput(id: string): Promise<void> {
    throw new ProviderSessionError(this.provider, id, 'Pi asks no questions Switch answers.');
  }

  async listModels(id: string): Promise<ModelChoice[]> {
    const { models } = await this.require(id).client.request<{ models: PiModel[] }>(
      'get_available_models'
    );
    return models.map((model) => ({
      id: modelKey(model)!,
      label: `${model.name ?? model.id} (${model.provider})`,
      options: {},
      imageInput: model.input?.includes('image') ?? null,
    }));
  }

  async setModel(id: string, model: ModelSelection): Promise<void> {
    const state = this.require(id);
    const slash = model.id.indexOf('/');
    if (slash <= 0)
      throw new ProviderSessionError(this.provider, id, `Unavailable model: ${model.id}`);
    await state.client.request('set_model', {
      provider: model.id.slice(0, slash),
      modelId: model.id.slice(slash + 1),
    });
    state.model = model.id;
  }

  async canCompact(id: string): Promise<boolean> {
    return !this.require(id).turn;
  }

  async compactSession(id: string): Promise<void> {
    const state = this.require(id);
    if (state.turn) throw new ProviderSessionError(this.provider, id, 'A turn is running.');
    await state.client.request('compact');
  }

  async stopSession(id: string): Promise<void> {
    const state = this.sessions.get(id);
    if (!state) return;
    state.stopping = true;
    if (state.turn) await this.interruptTurn(id).catch(() => {});
    await state.client.dispose();
    this.exited(id, 'Session stopped');
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stopSession(id)));
  }

  private drain(state: State): void {
    if (state.turn || state.stopping || !this.sessions.has(state.id)) return;
    const input = state.queue.shift();
    if (!input) return;
    state.turn = input.turnId;
    state.interrupted = false;
    state.items.clear();
    state.message = null;
    state.reasoning = null;
    state.usage.clear();
    state.error = undefined;
    state.declined.clear();
    this.emit(state, { type: 'turn.started', turnId: input.turnId });
    this.emit(state, { type: 'session.state.changed', status: 'running' });
    void this.run(state, input).catch((error: unknown) => {
      if (state.turn !== input.turnId) return;
      this.complete(
        state,
        state.interrupted ? 'interrupted' : 'error',
        state.interrupted ? 'Interrupted.' : String(error)
      );
    });
  }

  private async run(state: State, input: ProviderSendTurnInput): Promise<void> {
    if (input.model && input.model.id !== state.model) await this.setModel(state.id, input.model);
    const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
    const files: string[] = [];
    for (const { path, mimeType } of input.attachments ?? [])
      if (mimeType.startsWith('image/'))
        images.push({ type: 'image', data: (await readFile(path)).toString('base64'), mimeType });
      else files.push(`Attached file: ${path} (${mimeType})`);
    const result = await state.client.request<{ disposition?: string } | undefined>('prompt', {
      message: [input.text, ...files].join('\n\n'),
      ...(images.length ? { images } : {}),
    });
    // An extension command consumed it: no run follows, so nothing settles.
    if (result?.disposition === 'handled' && state.turn === input.turnId)
      this.complete(state, 'completed');
  }

  private event(state: State, event: PiRecord): void {
    const turnId = state.turn;
    if (event.type === 'extension_error') {
      this.emit(state, {
        type: 'runtime.warning',
        message: `A Pi extension failed in ${String(event.event)}: ${String(event.error)}`,
      });
      return;
    }
    if (!turnId) return;
    switch (event.type) {
      case 'message_update': {
        const update = event.assistantMessageEvent as { type: string; delta?: string };
        if (update.type === 'text_delta' && update.delta) {
          const message = this.assistant(state, turnId);
          message.text += update.delta;
          this.emit(state, {
            type: 'content.delta',
            turnId,
            itemId: message.id,
            delta: update.delta,
          });
        } else if (update.type === 'thinking_delta' && update.delta) {
          if (!state.reasoning) {
            state.reasoning = { id: `${turnId}:reasoning:${++state.messages}`, text: '' };
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
        return;
      }
      case 'message_end': {
        const message = event.message as PiMessage;
        if (message.role === 'assistant') this.finishMessage(state, turnId, message);
        return;
      }
      case 'tool_execution_start':
      case 'tool_execution_update': {
        const toolCallId = String(event.toolCallId);
        const toolName = String(event.toolName);
        const args = (event.args as Record<string, unknown> | undefined) ?? {};
        const started = !state.items.has(toolCallId);
        const item: ProviderItem = {
          id: toolCallId,
          type: itemType(toolName),
          status: 'in_progress',
          title: toolTitle(toolName, args),
          toolName,
          payload: { args },
          ...(event.type === 'tool_execution_update'
            ? { text: resultText(event.partialResult) }
            : {}),
        };
        state.items.set(toolCallId, item);
        this.emit(state, { type: started ? 'item.started' : 'item.updated', turnId, item });
        return;
      }
      case 'tool_execution_end': {
        const toolCallId = String(event.toolCallId);
        const toolName = String(event.toolName);
        const item: ProviderItem = {
          ...(state.items.get(toolCallId) ?? {
            id: toolCallId,
            type: itemType(toolName),
            title: toolName,
            toolName,
          }),
          status: state.declined.has(toolCallId)
            ? 'declined'
            : event.isError
              ? 'failed'
              : 'completed',
          text: resultText(event.result),
        };
        state.items.set(toolCallId, item);
        this.emit(state, { type: 'item.completed', turnId, item });
        return;
      }
      case 'auto_retry_start':
        this.emit(state, {
          type: 'runtime.warning',
          message: `Pi is retrying the model call: ${String(event.errorMessage)}`,
        });
        return;
      case 'agent_settled':
        if (event.aborted === true || state.interrupted)
          this.complete(state, 'interrupted', 'Interrupted.');
        else if (state.error) this.complete(state, 'error', state.error);
        else this.complete(state, 'completed');
        return;
    }
  }

  private assistant(state: State, turnId: string): NonNullable<State['message']> {
    if (!state.message)
      state.message = { id: `${turnId}:assistant:${++state.messages}`, text: '', started: false };
    if (!state.message.started) {
      state.message.started = true;
      this.emit(state, {
        type: 'item.started',
        turnId,
        item: {
          id: state.message.id,
          type: 'assistant_message',
          status: 'in_progress',
          title: 'Assistant',
        },
      });
    }
    return state.message;
  }

  private finishMessage(state: State, turnId: string, message: PiMessage): void {
    if (state.reasoning) {
      this.emit(state, {
        type: 'item.completed',
        turnId,
        item: {
          id: state.reasoning.id,
          type: 'reasoning',
          status: 'completed',
          title: 'Thinking',
          text: blocks(message, 'thinking') || state.reasoning.text,
        },
      });
      state.reasoning = null;
    }
    const final = blocks(message, 'text') || state.message?.text || '';
    if (final) {
      const item = this.assistant(state, turnId);
      this.emit(state, {
        type: 'item.completed',
        turnId,
        item: {
          id: item.id,
          type: 'assistant_message',
          status: 'completed',
          title: 'Assistant',
          text: final,
        },
      });
    }
    state.message = null;
    const usage = message.usage;
    // An aborted or failed call reports all zeros: nothing spent, not a free call.
    if (
      usage &&
      (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) >
        0
    ) {
      const model = message.model ?? '';
      const total = state.usage.get(model) ?? {
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
      state.usage.set(model, total);
    }
    if (message.stopReason === 'error')
      state.error = message.errorMessage ?? 'Pi reported an error from the model provider.';
  }

  private ui(state: State, request: PiUiRequest): void {
    if (request.method === 'setStatus') {
      if (request.statusKey !== PI_APPROVAL_STATUS) return;
      try {
        state.asking = request.statusText
          ? (JSON.parse(request.statusText) as State['asking'])
          : null;
      } catch {
        state.asking = null;
      }
      return;
    }
    if (request.method === 'notify') {
      if (request.notifyType === 'warning' || request.notifyType === 'error')
        this.emit(state, { type: 'runtime.warning', message: `Pi: ${request.message ?? ''}` });
      return;
    }
    if (!['select', 'confirm', 'input', 'editor'].includes(request.method)) return;
    const asking = state.asking;
    state.asking = null;
    const approval =
      request.method === 'select' &&
      asking &&
      JSON.stringify(request.options) === JSON.stringify(Object.values(PI_APPROVAL_OPTIONS));
    if (!approval || !state.turn || state.interrupted) {
      state.client.respondToUi(request.id, { cancelled: true });
      if (!approval)
        this.emit(state, {
          type: 'runtime.warning',
          message: `A Pi extension asked "${request.title ?? request.method}", which Switch cannot show; it was answered as cancelled.`,
        });
      return;
    }
    const requestId = randomUUID();
    state.approvals.set(requestId, { uiId: request.id, toolCallId: asking.toolCallId });
    const mcp = piMcpTool(asking.toolName);
    const kind = requestType(asking.toolName);
    this.emit(state, {
      type: 'request.opened',
      turnId: state.turn,
      requestId,
      requestType: kind,
      title:
        kind === 'command_execution_approval'
          ? 'Pi wants to run a command.'
          : kind === 'file_change_approval'
            ? 'Pi wants to change a file.'
            : mcp
              ? `Pi wants to use ${mcp.tool} from ${mcp.server}.`
              : `Pi wants to use ${asking.toolName}.`,
      detail:
        toolTitle(asking.toolName, asking.input) === asking.toolName
          ? JSON.stringify(asking.input)
          : toolTitle(asking.toolName, asking.input),
      options: [
        { decision: 'accept', label: PI_APPROVAL_OPTIONS.accept },
        { decision: 'acceptForSession', label: PI_APPROVAL_OPTIONS.acceptForSession },
        { decision: 'decline', label: PI_APPROVAL_OPTIONS.decline },
      ],
      ...(mcp && state.connectors.has(mcp.server) ? { connector: mcp.server } : {}),
    });
  }

  private complete(
    state: State,
    outcome: 'completed' | 'interrupted' | 'error',
    message?: string
  ): void {
    if (!state.turn) return;
    const turnId = state.turn;
    if (state.message?.started)
      this.emit(state, {
        type: 'item.completed',
        turnId,
        item: {
          id: state.message.id,
          type: 'assistant_message',
          status: outcome === 'completed' ? 'completed' : 'failed',
          title: 'Assistant',
          text: state.message.text,
        },
      });
    state.message = null;
    for (const item of state.items.values())
      if (item.status === 'in_progress')
        this.emit(state, { type: 'item.completed', turnId, item: { ...item, status: 'failed' } });
    this.cancelPending(state);
    state.turn = null;
    this.emit(state, {
      type: 'turn.completed',
      turnId,
      outcome,
      ...(message ? { message } : {}),
      usage: [...state.usage.values()],
    });
    this.emit(state, {
      type: 'session.state.changed',
      status: state.stopping ? 'stopped' : outcome === 'error' ? 'error' : 'ready',
    });
    this.drain(state);
  }

  private cancelPending(state: State): void {
    for (const [requestId, pending] of state.approvals) {
      state.declined.add(pending.toolCallId);
      state.client.respondToUi(pending.uiId, { cancelled: true });
      this.emit(state, { type: 'request.resolved', requestId, decision: 'cancel' });
    }
    state.approvals.clear();
  }

  private exited(id: string, reason: string): void {
    const state = this.sessions.get(id);
    if (!state) return;
    const stopping = state.stopping;
    state.stopping = true;
    this.complete(state, stopping ? 'interrupted' : 'error', reason);
    for (const input of state.queue.splice(0))
      this.emit(state, {
        type: 'turn.completed',
        turnId: input.turnId,
        outcome: 'error',
        message: reason,
        usage: [],
      });
    this.sessions.delete(id);
    void rm(state.dir, { recursive: true, force: true }).catch((error: unknown) =>
      this.logger.warn('Could not remove a Pi session folder', {
        dir: state.dir,
        error: String(error),
      })
    );
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
        this.logger.error('Pi event listener failed', { error: String(cause) });
      }
    }
  }
}

export function createPiAdapter(options: PiAdapterOptions = {}): PiAdapter {
  return new PiAdapter(options);
}
