import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  type RuntimeMode,
} from '../adapter';
import type {
  ApprovalDecision,
  ApprovalOption,
  ItemType,
  ProviderItem,
  ProviderRuntimeEvent,
  RequestType,
  TokenUsage,
  TurnOutcome,
} from '../events';
import { mcpApprovalContent, toolInputDetail } from '../mcp-approval';
import { noopLogger, type ProviderLogger } from '../transport/stdio-json-rpc';
import { mergeUsage } from '../usage';
import {
  assertNoShadowingServers,
  PI_EXTENSION_SOURCE,
  PI_SESSION_ENV,
  PI_TOOL_CALL_DIALOG,
  piMcpServers,
  piMcpToolPrefix,
} from './extension';
import { PiRpcClient, type PiRecord } from './rpc-client';
import { PI_SIGN_IN_REQUIRED } from './sign-in';

const PROVIDER = 'pi';
const TITLE_LIMIT = 200;

/**
 * The only commands sent to Pi. Its queue, compaction and retry settings
 * commands save to the user's `settings.json`, and a Switch session must not
 * change Pi's configuration outside itself.
 */
export const PI_COMMANDS = [
  'get_state',
  'get_session_stats',
  'prompt',
  'abort',
  'compact',
  'set_model',
  'get_available_models',
] as const;
type PiCommand = (typeof PI_COMMANDS)[number];

/**
 * Tools that only read, and codemode, whose every nested tool call is gated on
 * its own. `read_mcp_resource` is not here: a resource is its server's data,
 * so reading one asks when that server's tools do.
 */
const READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'tool_search',
  'codemode',
  'list_mcp_resources',
  'list_mcp_resource_templates',
]);
const READ_RESOURCE_TOOL = 'read_mcp_resource';
const COMMAND_TOOLS = new Set(['bash', 'powershell']);
const EDIT_TOOLS = new Set(['edit', 'write']);

const APPROVAL_OPTIONS: ApprovalOption[] = [
  { decision: 'accept', label: 'Approve' },
  { decision: 'acceptForSession', label: 'Approve for this session' },
  { decision: 'decline', label: 'Decline' },
  { decision: 'cancel', label: 'Cancel' },
];

interface PiState {
  sessionId: string;
  messageCount: number;
  model?: { provider?: string; id?: string };
}
interface PiModel {
  id: string;
  name?: string;
  provider: string;
  input?: string[];
}
interface PiContent {
  type: string;
  text?: string;
  thinking?: string;
}
interface PiMessage {
  role: string;
  content?: string | PiContent[];
  provider?: string;
  model?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  stopReason?: string;
  errorMessage?: string;
}
interface PiToolResult {
  content?: PiContent[];
  /** `patch` is the unified diff of what the edit tool changed. */
  details?: { patch?: unknown };
}
interface PiSessionStats {
  contextUsage?: { tokens: number | null; contextWindow: number };
}

/** A tool call as the Switch extension asks about it. */
export interface PiToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface SessionServer {
  name: string;
  prefix: string;
  connector: boolean;
}

/** What asking about a tool call shows, and what "Approve for this session" then allows. */
interface Ask {
  requestType: RequestType;
  title: string;
  detail?: string;
  connector?: string;
  allows: string;
}

interface PendingApproval {
  dialogId: string;
  toolCallId: string;
  allows: string;
}

interface StreamedItem {
  id: string;
  text: string;
}

interface State {
  id: string;
  nativeId: string;
  client: PiRpcClient;
  dir: string;
  /** The Switch extension's path, as Pi names the extension in its errors. */
  extension: string;
  cwd: string;
  runtimeMode: RuntimeMode;
  servers: SessionServer[];
  turn: string | null;
  queue: ProviderSendTurnInput[];
  interrupted: boolean;
  stopping: boolean;
  /** Why the session cannot go on, which ends it with an error. */
  fatal: string | undefined;
  compacting: boolean;
  message: StreamedItem | null;
  reasoning: StreamedItem | null;
  /** The last assistant message's error, which a turn that settles on it ends with. */
  failure: string | undefined;
  tools: Map<string, ProviderItem>;
  /** A compaction Pi started on its own during the turn, until it ends. */
  compaction: ProviderItem | null;
  declined: Set<string>;
  usage: TokenUsage[];
  approvals: Map<string, PendingApproval>;
  /** What "Approve for this session" allowed: `edits`, `command:<command>`, `tool:<name>`. */
  allowed: Set<string>;
}

type Emittable<T = ProviderRuntimeEvent> = T extends ProviderRuntimeEvent
  ? Omit<T, 'eventId' | 'provider' | 'sessionId' | 'createdAt'>
  : never;

export interface PiAdapterOptions {
  /** Defaults to `pi` on PATH. */
  binaryPath?: string;
  logger?: ProviderLogger;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function firstLine(value: string, fallback: string): string {
  const line = value
    .split('\n')
    .find((candidate) => candidate.trim().length > 0)
    ?.trim();
  if (!line) return fallback;
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
}

function contentText(content: PiMessage['content'], type: 'text' | 'thinking'): string {
  if (typeof content === 'string') return type === 'text' ? content : '';
  return (content ?? [])
    .filter((part) => part.type === type)
    .map((part) => text(type === 'text' ? part.text : part.thinking))
    .join('');
}

/** `mcp__<server>__<tool>` split at the server, for a server the session did not register. */
function mcpParts(toolName: string): { server: string; tool: string } {
  const rest = toolName.slice('mcp__'.length);
  const split = rest.indexOf('__');
  return split > 0
    ? { server: rest.slice(0, split), tool: rest.slice(split + 2) }
    : { server: rest, tool: rest };
}

/**
 * Pi's own coding agent, driven over its RPC mode (`pi --mode rpc`) with a
 * Switch extension loaded for the session alone. Pi never asks before a tool
 * runs, so the extension asks this adapter about every call and the runtime
 * mode is enforced here. Nothing is written to Pi's own configuration: the
 * extension and the session's MCP servers reach Pi through flags and a
 * directory of the session's own.
 */
export class PiAdapter implements ProviderAdapter {
  readonly provider = PROVIDER;
  readonly capabilities: ProviderCapabilities = {
    modelSwitchInSession: true,
    // A message sent mid-turn waits for the turn to settle, like the ACP
    // agents', rather than joining Pi's own steering queue.
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

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    if (this.sessions.has(input.sessionId))
      throw new ProviderSessionError(PROVIDER, input.sessionId, 'session already started');
    const cwd = await realpath(input.cwd);
    let mcpServers: ReturnType<typeof piMcpServers>;
    try {
      mcpServers = piMcpServers(input.mcpServers);
      await assertNoShadowingServers(Object.keys(input.mcpServers), cwd, input.env);
    } catch (cause) {
      throw new ProviderSessionError(PROVIDER, input.sessionId, messageOf(cause), { cause });
    }
    const dir = await mkdtemp(join(tmpdir(), 'switch-pi-'));
    const extension = join(dir, 'switch.js');
    let client: PiRpcClient;
    try {
      const session = join(dir, 'session.json');
      const context = join(dir, 'context.md');
      await writeFile(extension, PI_EXTENSION_SOURCE, { mode: 0o600 });
      await writeFile(session, JSON.stringify({ mcpServers }), { mode: 0o600 });
      if (input.systemContext) await writeFile(context, input.systemContext, { mode: 0o600 });
      client = new PiRpcClient({
        command: this.options.binaryPath ?? 'pi',
        args: [
          '--mode',
          'rpc',
          ...(input.resume ? ['--session-id', input.resume.nativeSessionId] : []),
          '-e',
          extension,
          ...(input.systemContext ? ['--append-system-prompt', context] : []),
        ],
        cwd,
        env: { ...input.env, [PI_SESSION_ENV]: session },
        logger: this.logger,
        onRecord: (record) => this.record(input.sessionId, record),
        onExit: (reason) => this.exited(input.sessionId, reason),
      });
    } catch (cause) {
      await rm(dir, { recursive: true, force: true });
      const message = `Could not start Pi: ${messageOf(cause)}`;
      throw new ProviderSessionError(PROVIDER, input.sessionId, message, { cause });
    }
    const state: State = {
      id: input.sessionId,
      nativeId: '',
      client,
      dir,
      extension,
      cwd,
      runtimeMode: input.runtimeMode,
      // Longest prefix first, so `mcp__a__b__` is not taken for server `a`.
      servers: Object.keys(input.mcpServers)
        .map((name) => ({
          name,
          prefix: piMcpToolPrefix(name),
          connector: input.connectorMcpServers.includes(name),
        }))
        .sort((a, b) => b.prefix.length - a.prefix.length),
      turn: null,
      queue: [],
      interrupted: false,
      stopping: false,
      fatal: undefined,
      compacting: false,
      message: null,
      reasoning: null,
      failure: undefined,
      tools: new Map(),
      compaction: null,
      declined: new Set(),
      usage: [],
      approvals: new Map(),
      allowed: new Set(),
    };
    this.sessions.set(state.id, state);
    this.emit(state, { type: 'session.state.changed', status: 'starting' });
    try {
      const ready = await this.command<PiState>(state, 'get_state');
      // Without a credential Pi starts on a placeholder model and refuses every prompt.
      if (!ready.model || ready.model.provider === 'unknown')
        throw new ProviderSessionError(PROVIDER, state.id, PI_SIGN_IN_REQUIRED);
      // Pi reports what its extensions failed at as it loads them, before it reads any command.
      if (state.fatal) throw new ProviderSessionError(PROVIDER, state.id, state.fatal);
      if (input.resume && !(ready.messageCount > 0))
        throw new ProviderConversationUnavailableError(
          PROVIDER,
          state.id,
          `Pi has no saved conversation ${input.resume.nativeSessionId} for ${cwd}.`
        );
      state.nativeId = ready.sessionId;
      if (input.model) await this.selectModel(state, input.model);
    } catch (cause) {
      this.sessions.delete(state.id);
      await client.dispose();
      await rm(dir, { recursive: true, force: true });
      if (cause instanceof ProviderSessionError) throw cause;
      throw new ProviderSessionError(
        PROVIDER,
        state.id,
        `Could not start Pi: ${messageOf(cause)}${client.stderr ? `\n${client.stderr}` : ''}`,
        { cause }
      );
    }
    this.emit(state, { type: 'session.started', nativeSessionId: state.nativeId });
    this.emit(state, { type: 'session.state.changed', status: 'ready' });
    return { provider: PROVIDER, sessionId: state.id, nativeSessionId: state.nativeId };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    const state = this.require(input.sessionId);
    state.queue.push(input);
    if (!state.turn) this.drain(state);
    return { turnId: input.turnId };
  }

  async interruptTurn(id: string): Promise<void> {
    const state = this.require(id);
    const turnId = state.turn;
    if (!turnId) return;
    state.interrupted = true;
    // What is still asked is answered first, so its cards close now rather
    // than when Pi is idle. Pi's abort would close the dialogs too (each is
    // tied to the turn's signal), and either way the calls stay blocked.
    this.cancelApprovals(state);
    await this.command(state, 'abort');
    if (state.turn === turnId) this.complete(state, 'interrupted', 'Interrupted.');
  }

  async respondToRequest(id: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const state = this.require(id);
    const pending = state.approvals.get(requestId);
    if (!pending) throw new ProviderSessionError(PROVIDER, id, `No pending approval ${requestId}`);
    try {
      this.answer(
        state,
        pending.dialogId,
        decision === 'accept' || decision === 'acceptForSession'
          ? { confirmed: true }
          : decision === 'decline'
            ? { confirmed: false }
            : { cancelled: true }
      );
    } catch (cause) {
      throw new ProviderSessionError(
        PROVIDER,
        id,
        `Pi did not take the answer to approval ${requestId}: ${messageOf(cause)}`,
        { cause }
      );
    }
    state.approvals.delete(requestId);
    if (decision === 'acceptForSession') state.allowed.add(pending.allows);
    if (decision === 'decline' || decision === 'cancel') state.declined.add(pending.toolCallId);
    this.emit(state, { type: 'request.resolved', requestId, decision });
    // Cancel stops the turn, as it does for the other providers; decline only blocks the call.
    if (decision === 'cancel') await this.interruptTurn(id);
  }

  async respondToUserInput(id: string): Promise<void> {
    throw new ProviderSessionError(PROVIDER, id, 'Pi asks no questions over RPC.');
  }

  async compactSession(id: string): Promise<void> {
    const state = this.require(id);
    if (state.turn || state.compacting) throw new Error('SESSION_BUSY');
    state.compacting = true;
    try {
      await this.command(state, 'compact');
    } finally {
      state.compacting = false;
    }
  }

  async listModels(id: string): Promise<ModelChoice[]> {
    const state = this.require(id);
    const { models } = await this.command<{ models: PiModel[] }>(state, 'get_available_models');
    return models.map((model) => ({
      id: `${model.provider}/${model.id}`,
      label: `${model.provider}: ${model.name || model.id}`,
      options: {},
      imageInput: model.input ? model.input.includes('image') : null,
    }));
  }

  async setModel(id: string, model: ModelSelection): Promise<void> {
    await this.selectModel(this.require(id), model);
  }

  /** Pi's own estimate; unknown after a compaction until the model has answered again. */
  async contextUsage(id: string): Promise<{ usedTokens: number; windowTokens: number } | null> {
    const { contextUsage } = await this.command<PiSessionStats>(
      this.require(id),
      'get_session_stats'
    );
    if (!contextUsage || contextUsage.tokens === null) return null;
    return { usedTokens: contextUsage.tokens, windowTokens: contextUsage.contextWindow };
  }

  async stopSession(id: string): Promise<void> {
    const state = this.sessions.get(id);
    if (!state) return;
    state.stopping = true;
    this.cancelApprovals(state);
    try {
      await state.client.dispose();
    } finally {
      this.exited(id, 'Session stopped');
      await rm(state.dir, { recursive: true, force: true });
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stopSession(id)));
  }

  /**
   * Pi matches `provider/id` exactly. It records the choice in the session's
   * own conversation, so a resume keeps it, and never in its `settings.json`.
   */
  private async selectModel(state: State, model: ModelSelection): Promise<void> {
    const slash = model.id.indexOf('/');
    if (slash <= 0)
      throw new ProviderSessionError(
        PROVIDER,
        state.id,
        `Pi names models provider/model; ${model.id} is not one.`
      );
    await this.command(state, 'set_model', {
      provider: model.id.slice(0, slash),
      modelId: model.id.slice(slash + 1),
    });
  }

  private drain(state: State): void {
    if (state.turn || state.stopping || !this.sessions.has(state.id)) return;
    const input = state.queue.shift();
    if (!input) return;
    state.turn = input.turnId;
    state.interrupted = false;
    state.message = null;
    state.reasoning = null;
    state.failure = undefined;
    state.tools.clear();
    state.declined.clear();
    state.usage = [];
    this.emit(state, { type: 'turn.started', turnId: input.turnId });
    this.emit(state, { type: 'session.state.changed', status: 'running' });
    this.prompt(state, input).catch((error: unknown) => {
      if (state.turn === input.turnId)
        this.complete(state, state.interrupted ? 'interrupted' : 'error', messageOf(error));
    });
  }

  private async prompt(state: State, input: ProviderSendTurnInput): Promise<void> {
    if (input.model) await this.selectModel(state, input.model);
    const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
    const files: string[] = [];
    for (const attachment of input.attachments ?? []) {
      if (attachment.mimeType.startsWith('image/'))
        images.push({
          type: 'image',
          data: (await readFile(attachment.path)).toString('base64'),
          mimeType: attachment.mimeType,
        });
      else files.push(attachment.path);
    }
    const message = files.length
      ? `${input.text}\n\nAttached files:\n${files.map((path) => `- ${path}`).join('\n')}`
      : input.text;
    const { disposition } = await this.command<{ disposition: string }>(state, 'prompt', {
      message,
      ...(images.length ? { images } : {}),
    });
    // A prompt an extension handles itself starts no run, so nothing will settle it.
    if (disposition === 'handled' && state.turn === input.turnId) this.complete(state, 'completed');
  }

  private record(id: string, record: PiRecord): void {
    const state = this.sessions.get(id);
    if (!state) return;
    switch (record.type) {
      case 'message_update':
        return this.streamed(
          state,
          record.assistantMessageEvent as { type?: string; delta?: unknown }
        );
      case 'message_end':
        return this.messageEnd(state, record.message as PiMessage);
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
        return this.tool(state, record);
      case 'agent_settled': {
        const aborted = record.aborted === true || state.interrupted;
        if (!state.turn) return;
        if (aborted) this.complete(state, 'interrupted', 'Interrupted.');
        else
          this.complete(state, state.failure === undefined ? 'completed' : 'error', state.failure);
        return;
      }
      case 'compaction_start':
        return this.compactionStarted(state, record);
      case 'compaction_end':
        return this.compactionEnded(state, record);
      case 'auto_retry_start':
        return this.emit(state, {
          type: 'runtime.warning',
          message: `Pi is retrying a failed model call (attempt ${String(record.attempt)} of ${String(record.maxAttempts)}): ${text(record.errorMessage)}`,
        });
      case 'extension_error':
        if (record.event === 'register_mcp_server' && record.extensionPath === state.extension)
          return this.unconnected(state, text(record.error));
        return this.emit(state, {
          type: 'runtime.warning',
          message: `A Pi extension failed in ${text(record.event)}: ${text(record.error)}`,
        });
      case 'extension_ui_request':
        return this.extensionRequest(state, record);
      case 'response':
        this.logger.warn('Pi answered a command this adapter did not send', {
          command: record.command,
          error: record.error,
        });
        return;
    }
  }

  /**
   * Pi took the session's MCP servers but nothing in it connects them: its
   * built-in MCP support is turned off or replaced. The agent would have no
   * Switch tools, so the session does not go on.
   */
  private unconnected(state: State, error: string): void {
    if (state.fatal) return;
    state.fatal = `Pi cannot connect the session's MCP servers, so the agent would have no Switch tools (${error}). Turn Pi's built-in MCP support back on: remove "-builtin:mcp" from the extensions in its settings, or the extension that replaced it.`;
    // Before the session has started, its start refuses it.
    if (!state.nativeId) return;
    this.emit(state, { type: 'runtime.error', message: state.fatal });
    this.stopSession(state.id).catch((error: unknown) =>
      this.logger.error('Could not stop a Pi session', { error: messageOf(error) })
    );
  }

  private streamed(state: State, event: { type?: string; delta?: unknown }): void {
    const turnId = state.turn;
    const delta = text(event?.delta);
    if (!turnId || !delta) return;
    if (event.type === 'text_delta') {
      if (!state.message) {
        state.message = { id: randomUUID(), text: '' };
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
      state.message.text += delta;
      this.emit(state, { type: 'content.delta', turnId, itemId: state.message.id, delta });
    } else if (event.type === 'thinking_delta') {
      if (!state.reasoning) {
        state.reasoning = { id: randomUUID(), text: '' };
        this.emit(state, {
          type: 'item.started',
          turnId,
          item: {
            id: state.reasoning.id,
            type: 'reasoning',
            status: 'in_progress',
            title: 'Reasoning',
            text: '',
          },
        });
      }
      state.reasoning.text += delta;
      this.emit(state, { type: 'item.delta', turnId, itemId: state.reasoning.id, delta });
    }
  }

  /** An assistant message is final at its end, where Pi gives its whole text and what it cost. */
  private messageEnd(state: State, message: PiMessage): void {
    const turnId = state.turn;
    if (!turnId || message?.role !== 'assistant') return;
    const thinking = contentText(message.content, 'thinking') || state.reasoning?.text || '';
    if (state.reasoning || thinking) {
      const id = state.reasoning?.id ?? randomUUID();
      this.emit(state, {
        type: 'item.completed',
        turnId,
        item: {
          id,
          type: 'reasoning',
          status: 'completed',
          title: firstLine(thinking, 'Reasoning'),
          text: thinking,
        },
      });
    }
    const reply = contentText(message.content, 'text') || state.message?.text || '';
    if (reply) {
      if (!state.message) {
        // Pi streamed none of it: it arrives whole, as one delta.
        const id = randomUUID();
        state.message = { id, text: reply };
        this.emit(state, {
          type: 'item.started',
          turnId,
          item: { id, type: 'assistant_message', status: 'in_progress', title: '', text: '' },
        });
        this.emit(state, { type: 'content.delta', turnId, itemId: id, delta: reply });
      }
      this.emit(state, {
        type: 'item.completed',
        turnId,
        item: {
          id: state.message.id,
          type: 'assistant_message',
          status:
            message.stopReason === 'error' || message.stopReason === 'aborted'
              ? 'failed'
              : 'completed',
          title: firstLine(reply, 'Assistant'),
          text: reply,
        },
      });
    }
    state.message = null;
    state.reasoning = null;
    state.failure =
      message.stopReason === 'error'
        ? message.errorMessage || 'Pi stopped on a model error.'
        : undefined;
    const spent: TokenUsage = {
      model: message.provider && message.model ? `${message.provider}/${message.model}` : '',
      inputTokens: message.usage?.input ?? 0,
      outputTokens: message.usage?.output ?? 0,
      cacheReadTokens: message.usage?.cacheRead ?? 0,
      cacheWriteTokens: message.usage?.cacheWrite ?? 0,
    };
    if (spent.inputTokens || spent.outputTokens || spent.cacheReadTokens || spent.cacheWriteTokens)
      state.usage = mergeUsage(state.usage, [spent]);
  }

  private tool(state: State, record: PiRecord): void {
    const turnId = state.turn;
    const id = text(record.toolCallId);
    if (!turnId || !id) return;
    const toolName = text(record.toolName);
    const input = (record.args ?? {}) as Record<string, unknown>;
    let item = state.tools.get(id);
    if (!item) {
      item = this.toolItem(state, id, toolName, input);
      state.tools.set(id, item);
      this.emit(state, { type: 'item.started', turnId, item });
    }
    if (record.type === 'tool_execution_start') return;
    if (record.type === 'tool_execution_update') {
      const update = { ...item, text: resultText(record.partialResult as PiToolResult) };
      state.tools.set(id, update);
      this.emit(state, { type: 'item.updated', turnId, item: update });
      return;
    }
    const result = record.result as PiToolResult | undefined;
    // An edit's result says only how many blocks it replaced; its patch shows the change.
    const patch = item.type === 'file_change' ? result?.details?.patch : undefined;
    const output = typeof patch === 'string' && patch ? patch : resultText(result);
    const done: ProviderItem = {
      ...item,
      status: state.declined.has(id)
        ? 'declined'
        : record.isError === true
          ? 'failed'
          : 'completed',
      ...(output ? { text: output } : {}),
    };
    state.tools.set(id, done);
    this.emit(state, { type: 'item.completed', turnId, item: done });
  }

  private toolItem(
    state: State,
    id: string,
    toolName: string,
    input: Record<string, unknown>
  ): ProviderItem {
    const type: ItemType = COMMAND_TOOLS.has(toolName)
      ? 'command_execution'
      : EDIT_TOOLS.has(toolName)
        ? 'file_change'
        : toolName.startsWith('mcp__')
          ? 'mcp_tool_call'
          : 'tool_call';
    if (type === 'mcp_tool_call') {
      const server = this.serverOf(state, toolName);
      const { server: name, tool } = server
        ? { server: server.name, tool: toolName.slice(server.prefix.length) }
        : mcpParts(toolName);
      return {
        id,
        type,
        status: 'in_progress',
        title: `${name}.${tool}`,
        toolName: tool,
        payload: { server: name },
      };
    }
    const subject = text(input.command) || text(input.path) || text(input.pattern);
    return {
      id,
      type,
      status: 'in_progress',
      title:
        type === 'tool_call'
          ? firstLine(subject ? `${toolName} ${subject}` : toolName, toolName)
          : firstLine(subject, toolName),
      toolName,
    };
  }

  /**
   * A compaction Pi runs on its own inside a turn, when the context passes its
   * threshold or overflows, shown as a compaction item, as Codex's is. The one
   * Console asks for runs outside any turn, and `compactSession` reports it.
   */
  private compactionStarted(state: State, record: PiRecord): void {
    const turnId = state.turn;
    if (!turnId || state.compaction) return;
    state.compaction = {
      id: randomUUID(),
      type: 'context_compaction',
      status: 'in_progress',
      title: 'Context compaction',
      payload: { reason: text(record.reason) },
    };
    this.emit(state, { type: 'item.started', turnId, item: state.compaction });
  }

  /** Pi gives a result when the compaction succeeded, and none when it failed or was aborted. */
  private compactionEnded(state: State, record: PiRecord): void {
    const turnId = state.turn;
    const item = state.compaction;
    if (!turnId || !item) return;
    state.compaction = null;
    const result = record.result as
      | { tokensBefore?: unknown; estimatedTokensAfter?: unknown }
      | undefined;
    const failure = result
      ? ''
      : text(record.errorMessage) ||
        (record.aborted === true ? 'The compaction was aborted.' : 'The compaction failed.');
    this.emit(state, {
      type: 'item.completed',
      turnId,
      item: {
        ...item,
        status: result ? 'completed' : 'failed',
        ...(failure ? { text: failure } : {}),
        payload: {
          ...item.payload,
          ...(result
            ? {
                tokensBefore: result.tokensBefore,
                estimatedTokensAfter: result.estimatedTokensAfter,
              }
            : {}),
        },
      },
    });
  }

  private extensionRequest(state: State, record: PiRecord): void {
    const dialogId = text(record.id);
    const method = text(record.method);
    if (method === 'notify') {
      if (record.notifyType === 'warning' || record.notifyType === 'error')
        this.emit(state, { type: 'runtime.warning', message: `Pi: ${text(record.message)}` });
      return;
    }
    if (!['confirm', 'select', 'input', 'editor'].includes(method)) return;
    if (method === 'confirm' && record.title === PI_TOOL_CALL_DIALOG) {
      this.toolCallDialog(state, dialogId, text(record.message));
      return;
    }
    // Another extension's dialog: a Switch session has no terminal to answer it in.
    this.answerQuietly(state, dialogId, { cancelled: true });
    this.emit(state, {
      type: 'runtime.warning',
      message: `A Pi extension asked "${text(record.title)}", which a Switch session cannot answer, so it was dismissed.`,
    });
  }

  private toolCallDialog(state: State, dialogId: string, message: string): void {
    let call: PiToolCall | undefined;
    try {
      call = JSON.parse(message) as PiToolCall;
    } catch {
      call = undefined;
    }
    if (typeof call?.toolName !== 'string') {
      this.answerQuietly(state, dialogId, { confirmed: false });
      this.emit(state, {
        type: 'runtime.warning',
        message: 'Pi asked about a tool call Switch could not read, so the call was blocked.',
      });
      return;
    }
    const turnId = state.turn;
    if (!turnId || state.interrupted) {
      this.answerQuietly(state, dialogId, { confirmed: false });
      return;
    }
    const ask = this.gate(state, { ...call, input: call.input ?? {} });
    if (!ask) {
      this.answerQuietly(state, dialogId, { confirmed: true });
      return;
    }
    const requestId = randomUUID();
    state.approvals.set(requestId, {
      dialogId,
      toolCallId: text(call.toolCallId),
      allows: ask.allows,
    });
    this.emit(state, {
      type: 'request.opened',
      turnId,
      requestId,
      requestType: ask.requestType,
      title: ask.title,
      ...(ask.detail ? { detail: ask.detail } : {}),
      options: APPROVAL_OPTIONS,
      ...(ask.connector ? { connector: ask.connector } : {}),
    });
  }

  /**
   * Whether a tool call needs a person, and how to ask. A tool on one of the
   * session's own MCP servers runs in every mode, as do tools that only read
   * and reading a resource of one of those servers; full access runs
   * everything. Auto mode allows edits and asks before commands, as
   * accept-edits does: Pi has no automatic review of its own.
   */
  private gate(state: State, call: PiToolCall): Ask | null {
    const { toolName, input } = call;
    const server = this.serverOf(state, toolName);
    if (server && !server.connector) return null;
    if (state.runtimeMode === 'full-access' || READ_ONLY_TOOLS.has(toolName)) return null;
    if (toolName === READ_RESOURCE_TOOL) {
      const name = text(input.server);
      const own = state.servers.find((other) => other.name === name);
      if ((own && !own.connector) || state.allowed.has(`resource:${name}`)) return null;
      const uri = text(input.uri);
      return {
        requestType: 'mcp_tool_approval',
        title: `${name || 'An MCP server'} wants to share one of its resources`,
        ...(uri ? { detail: uri } : {}),
        ...(own?.connector ? { connector: name } : {}),
        allows: `resource:${name}`,
      };
    }
    if (EDIT_TOOLS.has(toolName)) {
      if (state.runtimeMode !== 'approval-required' || state.allowed.has('edits')) return null;
      const path = text(input.path);
      return {
        requestType: 'file_change_approval',
        title: 'Apply file changes',
        ...(path ? { detail: path } : {}),
        allows: 'edits',
      };
    }
    if (COMMAND_TOOLS.has(toolName)) {
      const command = text(input.command);
      if (state.allowed.has(`command:${command}`)) return null;
      return {
        requestType: 'command_execution_approval',
        title: `Run a command in ${state.cwd}`,
        ...(command ? { detail: command } : {}),
        allows: `command:${command}`,
      };
    }
    if (state.allowed.has(`tool:${toolName}`)) return null;
    if (toolName.startsWith('mcp__')) {
      const { server: name, tool } = server
        ? { server: server.name, tool: toolName.slice(server.prefix.length) }
        : mcpParts(toolName);
      return {
        requestType: 'mcp_tool_approval',
        ...mcpApprovalContent(name, tool, input),
        ...(server?.connector ? { connector: server.name } : {}),
        allows: `tool:${toolName}`,
      };
    }
    const detail = toolInputDetail(input);
    return {
      requestType: 'tool_approval',
      title: `Pi wants to run ${toolName}`,
      ...(detail ? { detail } : {}),
      allows: `tool:${toolName}`,
    };
  }

  private serverOf(state: State, toolName: string): SessionServer | undefined {
    return state.servers.find((server) => toolName.startsWith(server.prefix));
  }

  private answer(
    state: State,
    dialogId: string,
    response: { confirmed: boolean } | { cancelled: true }
  ): void {
    state.client.send({ type: 'extension_ui_response', id: dialogId, ...response });
  }

  /**
   * Answers a dialog nobody waits on: one decided without a person, or one
   * closed as the turn ends. Pi refuses the answer only when its input is
   * closed, as it shuts down, and the call stays blocked.
   */
  private answerQuietly(
    state: State,
    dialogId: string,
    response: { confirmed: boolean } | { cancelled: true }
  ): void {
    try {
      this.answer(state, dialogId, response);
    } catch (error) {
      this.logger.warn('Pi did not take the answer to a tool call; it stays blocked', {
        error: messageOf(error),
      });
    }
  }

  private cancelApprovals(state: State): void {
    for (const [requestId, pending] of state.approvals) {
      this.answerQuietly(state, pending.dialogId, { cancelled: true });
      this.emit(state, { type: 'request.resolved', requestId, decision: 'cancel' });
    }
    state.approvals.clear();
  }

  private complete(state: State, outcome: TurnOutcome, message?: string): void {
    const turnId = state.turn;
    if (!turnId) return;
    for (const [streamed, type, title] of [
      [state.message, 'assistant_message', 'Assistant'],
      [state.reasoning, 'reasoning', 'Reasoning'],
    ] as const)
      if (streamed)
        this.emit(state, {
          type: 'item.completed',
          turnId,
          item: {
            id: streamed.id,
            type,
            status: 'failed',
            title: firstLine(streamed.text, title),
            text: streamed.text,
          },
        });
    state.message = null;
    state.reasoning = null;
    for (const item of [...state.tools.values(), ...(state.compaction ? [state.compaction] : [])])
      if (item.status === 'in_progress')
        this.emit(state, { type: 'item.completed', turnId, item: { ...item, status: 'failed' } });
    state.compaction = null;
    this.cancelApprovals(state);
    state.turn = null;
    this.emit(state, {
      type: 'turn.completed',
      turnId,
      outcome,
      ...(message ? { message } : {}),
      usage: state.usage,
    });
    this.emit(state, {
      type: 'session.state.changed',
      status: state.stopping ? 'stopped' : outcome === 'error' ? 'error' : 'ready',
    });
    this.drain(state);
  }

  private exited(id: string, reason: string): void {
    const state = this.sessions.get(id);
    if (!state) return;
    const stopping = state.stopping;
    state.stopping = true;
    const said = stopping ? '' : state.client.stderr.trim().slice(-2000);
    const why =
      state.fatal ?? (stopping ? 'Session stopped' : said ? `${reason}: ${said}` : reason);
    this.complete(state, stopping && !state.fatal ? 'interrupted' : 'error', why);
    for (const queued of state.queue.splice(0))
      this.emit(state, {
        type: 'turn.completed',
        turnId: queued.turnId,
        outcome: 'error',
        message: why,
        usage: [],
      });
    this.sessions.delete(id);
    this.emit(state, { type: 'session.state.changed', status: 'stopped' });
    this.emit(state, { type: 'session.exited', reason: why });
    if (!stopping)
      rm(state.dir, { recursive: true, force: true }).catch((error: unknown) =>
        this.logger.error('Could not remove a Pi session directory', { error: messageOf(error) })
      );
  }

  private command<T>(
    state: State,
    type: PiCommand,
    fields: Record<string, unknown> = {}
  ): Promise<T> {
    return state.client.command<T>(type, fields);
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
        this.logger.error('Pi event listener failed', { error: String(cause) });
      }
    }
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function resultText(result: PiToolResult | undefined): string {
  return (result?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => text(part.text))
    .join('\n');
}

export function createPiAdapter(options: PiAdapterOptions = {}): PiAdapter {
  return new PiAdapter(options);
}
