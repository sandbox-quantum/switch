import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  EffortLevel,
  HookCallback,
  McpServerConfig,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  ModelSelection,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../adapter';
import { ProviderSessionError, ProviderUnavailableError } from '../adapter';
import type {
  ApprovalDecision,
  ApprovalOption,
  ItemStatus,
  ProviderItem,
  ProviderRuntimeEvent,
  TurnOutcome,
  UserInputAnswers,
  UserInputQuestion,
} from '../events';
import {
  isRecord,
  itemTypeForTool,
  outcomeForResult,
  parseAskUserQuestionInput,
  PERMISSION_MODE_BY_RUNTIME_MODE,
  requestTypeForTool,
  resultMessageText,
  textFromToolResultContent,
  toMcpServerConfig,
  toolNameForItem,
  toolTitle,
  truncate,
} from './claude-mapping';

const PROVIDER = 'claude';
const ASK_USER_QUESTION = 'AskUserQuestion';

/**
 * The tools whose permission this adapter insists on being asked about, as a
 * hook matcher.
 *
 * Deliberately the tools Claude Code already asks about in `default` mode —
 * running a command and changing a file — and no others. A hook decision
 * outranks the permission rules, so widening this would start prompting for
 * reads and searches that nothing asks about today, and a session that asks
 * before every `Read` cannot answer a room.
 */
const APPROVAL_TOOLS = 'Bash|Edit|Write|MultiEdit|NotebookEdit';
const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const APPROVAL_OPTIONS: ApprovalOption[] = [
  { decision: 'accept', label: 'Allow once' },
  { decision: 'acceptForSession', label: 'Allow for this session' },
  { decision: 'decline', label: 'Decline' },
];

export interface ClaudeAdapterLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

export interface ClaudeAdapterOptions {
  /**
   * Claude Code binary to drive. Defaults to the one on the session's own
   * `PATH` (so the user's login and CLI version are used) and falls back to
   * the executable the SDK bundles when there is none.
   */
  claudeExecutablePath?: string;
  logger?: ClaudeAdapterLogger;
  /** Test seam: a scripted stand-in for the SDK's `query()`. */
  query?: typeof sdkQuery;
}

type EventBody<T extends ProviderRuntimeEvent = ProviderRuntimeEvent> =
  T extends ProviderRuntimeEvent
    ? Omit<T, 'eventId' | 'provider' | 'sessionId' | 'createdAt'>
    : never;

interface PendingApproval {
  turnId: string;
  settle: (decision: ApprovalDecision) => void;
}

interface PendingUserInput {
  turnId: string;
  settle: (answers: UserInputAnswers) => void;
}

interface ActiveTurn {
  turnId: string;
  /** Message uuids this turn is still waiting on a `result` for. */
  outstanding: Set<string>;
}

interface TextBlockState {
  itemId: string;
  text: string;
}

interface SessionState {
  sessionId: string;
  nativeSessionId: string;
  query: Query;
  runtimeMode: ProviderSessionStartInput['runtimeMode'];
  /** `mcp__<server>__` prefixes for the servers the caller registered. */
  registeredMcpPrefixes: string[];
  input: PromptQueue;
  turn: ActiveTurn | null;
  pendingApprovals: Map<string, PendingApproval>;
  pendingUserInputs: Map<string, PendingUserInput>;
  toolItems: Map<string, ProviderItem>;
  streamedMessageIds: Set<string>;
  textBlocks: Map<number, TextBlockState>;
  streamMessageId: string | null;
  stopping: boolean;
  exited: boolean;
}

/** An async iterable the adapter pushes into for the life of the session. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    this.queued.push(message);
    this.wake?.();
    this.wake = null;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.queued.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

/**
 * The Claude Code the session should drive. The installed CLI is preferred over
 * the one the SDK bundles so the session runs the version the user logged in
 * with; `undefined` means "let the SDK use its own".
 */
export function resolveClaudeExecutable(
  configured: string | undefined,
  env: Record<string, string>
): string | undefined {
  if (configured !== undefined) return configured;
  const candidates: string[] = [];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir.length > 0) candidates.push(join(dir, 'claude'));
  }
  if (env.HOME !== undefined) candidates.push(join(env.HOME, '.local', 'bin', 'claude'));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function effortFrom(model: ModelSelection | undefined): EffortLevel | undefined {
  const raw = model?.options?.effort;
  return EFFORT_LEVELS.find((level) => level === raw);
}

/**
 * The tool-name prefixes covering the tools of the MCP servers the caller
 * registered. Claude Code names an MCP tool `mcp__<server>__<tool>`, folding
 * anything outside `[A-Za-z0-9_-]` in the server name to `_`.
 *
 * Their tools are allowed rather than asked about because a session's MCP
 * servers are exactly the ones the caller registered for it — passing
 * `mcpServers` puts the CLI in strict MCP config, so the user's own
 * registrations are not there to be confused with these. For Switch Console
 * that server is the room protocol, and a session that must ask a human before
 * it may speak in the room cannot answer the room at all — including to ask.
 */
export function mcpToolPrefixes(names: string[]): string[] {
  return names.map((name) => `mcp__${name.replace(/[^A-Za-z0-9_-]/g, '_')}__`);
}

/** Rescoped so "allow for this session" never writes a rule to the user's settings. */
function sessionScoped(suggestions: readonly PermissionUpdate[] | undefined): PermissionUpdate[] {
  return (suggestions ?? []).map((suggestion) => ({ ...suggestion, destination: 'session' }));
}

/**
 * Take the permission decision back from whatever else is hooked into this
 * session, so the caller is the one asked.
 *
 * A `PreToolUse` hook's `allow` settles the permission outright: measured
 * against Claude Code 2.1.260, `canUseTool` is then never called and the tool
 * runs. The session loads the user's own settings and plugins, and the Switch
 * connector plugin's hook answers `allow` for every tool Switch's mediation
 * lets proceed — which is right for a session a human is watching in a
 * terminal, and wrong for one whose only human is in a room: it ran shell
 * commands with nobody ever offered the approval card.
 *
 * `ask` from a hook outranks another hook's `allow` (measured the same way) and
 * hands the tool to `canUseTool`, which is where this adapter asks. It does not
 * outrank a `deny`, so a mediation that actually blocks a call still blocks it.
 */
const reclaimPermission: HookCallback = async (input) => {
  if (input.hook_event_name !== 'PreToolUse') return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } };
};

function turnStatusMessage(result: SDKResultMessage, outcome: TurnOutcome): string | undefined {
  if (outcome === 'completed') return undefined;
  return resultMessageText(result) ?? `Claude turn ended: ${result.subtype}`;
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = PROVIDER;

  /**
   * `userInput` describes the round trip this adapter implements, not how often
   * it fires: Claude Code 2.1.260 does not offer `AskUserQuestion` to an SDK
   * session, so nothing asks today. The PreToolUse hook that answers it is
   * registered regardless, so a CLI that starts offering the tool is handled
   * without a change here.
   */
  readonly capabilities: ProviderCapabilities = {
    modelSwitchInSession: true,
    steering: true,
    resume: true,
    approvals: true,
    userInput: true,
  };

  private readonly sessions = new Map<string, SessionState>();
  private readonly listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly executablePath: string | undefined;
  private readonly logger: ClaudeAdapterLogger | undefined;
  private readonly queryFn: typeof sdkQuery;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.executablePath = options.claudeExecutablePath;
    this.logger = options.logger;
    this.queryFn = options.query ?? sdkQuery;
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Start a Claude Code session.
   *
   * `settingSources` is left unset, which loads what the CLI itself would: the
   * user's settings, their installed plugins and their skills, and the project's
   * `.claude/agents/<name>.md` definitions that {@link ProviderSessionStartInput.agentName}
   * names. Passing `mcpServers` puts the CLI in strict MCP config — measured
   * against 2.1.260, the session's `init` then lists *only* the servers passed
   * here, so a server the user has registered for the same purpose (the Switch
   * connector plugin's own) is not loaded a second time, while that plugin's
   * skills and hooks still are.
   */
  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    if (this.sessions.has(input.sessionId)) {
      throw new ProviderSessionError(PROVIDER, input.sessionId, 'Session already started.');
    }

    const prompt = new PromptQueue();
    const mcpServers: Record<string, McpServerConfig> = {};
    for (const [name, spec] of Object.entries(input.mcpServers)) {
      mcpServers[name] = toMcpServerConfig(spec);
    }
    const permissionMode = PERMISSION_MODE_BY_RUNTIME_MODE[input.runtimeMode];
    const effort = effortFrom(input.model);
    const executable = resolveClaudeExecutable(this.executablePath, input.env);

    const nativeSessionId = input.resume?.nativeSessionId ?? randomUUID();

    const options: Options = {
      cwd: input.cwd,
      env: input.env,
      permissionMode,
      ...(permissionMode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true }
        : { canUseTool: this.makeCanUseTool(input.sessionId) }),
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      ...(input.agentName ? { agent: input.agentName } : {}),
      ...(input.model ? { model: input.model.id } : {}),
      ...(effort ? { effort } : {}),
      ...(input.resume ? { resume: nativeSessionId } : { sessionId: nativeSessionId }),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(input.systemContext ? { append: input.systemContext } : {}),
      },
      hooks: {
        PreToolUse: [
          { matcher: ASK_USER_QUESTION, hooks: [this.makeAskUserQuestionHook(input.sessionId)] },
          ...(permissionMode === 'bypassPermissions'
            ? []
            : [{ matcher: APPROVAL_TOOLS, hooks: [reclaimPermission] }]),
        ],
      },
      includePartialMessages: true,
      stderr: (data) => this.logger?.debug('claude stderr', { sessionId: input.sessionId, data }),
    };

    let running: Query;
    try {
      running = this.queryFn({ prompt, options });
    } catch (cause) {
      throw new ProviderUnavailableError(PROVIDER, 'Failed to start Claude Code.', { cause });
    }

    const session: SessionState = {
      sessionId: input.sessionId,
      nativeSessionId,
      query: running,
      runtimeMode: input.runtimeMode,
      registeredMcpPrefixes: mcpToolPrefixes(Object.keys(mcpServers)),
      input: prompt,
      turn: null,
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      toolItems: new Map(),
      streamedMessageIds: new Set(),
      textBlocks: new Map(),
      streamMessageId: null,
      stopping: false,
      exited: false,
    };
    this.sessions.set(input.sessionId, session);
    this.emit(session, { type: 'session.state.changed', status: 'starting' });
    this.emit(session, { type: 'session.started', nativeSessionId });
    if (executable === undefined) {
      // Disclosed rather than silent: the bundled CLI is a different build from
      // the one the user logged in with, so a session that falls back here can
      // report itself unauthenticated for no visible reason.
      this.emit(session, {
        type: 'runtime.warning',
        message:
          'No `claude` executable on this session’s PATH — running the CLI bundled with the Agent SDK, which does not share the installed one’s login.',
      });
    }
    this.pump(session);
    return { sessionId: input.sessionId, nativeSessionId, provider: PROVIDER };
  }

  /**
   * A send while a turn is running is pushed into the same live query. Measured
   * against Claude Code 2.1.260: the CLI does not abort the running turn — it
   * finishes it, emits its own `result`, then runs the queued message and emits
   * a second `result`. (Between tool rounds it instead folds the message into
   * the running turn and emits one `result` naming both sends.) Either way
   * every `result` names the sends it consumed in `user_message_uuids`, so the
   * turn stays open until the last pushed message has been answered, and the
   * caller sees one `turn.started` / `turn.completed` pair reported through
   * `steeredInto`.
   */
  async sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    const session = this.requireSession(input.sessionId);
    if (input.model) await this.applyModel(session, input.model);

    const uuid = randomUUID();
    const text = this.composeText(input);
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: session.nativeSessionId,
      uuid,
    };

    const steeredInto = session.turn?.turnId;
    if (session.turn) {
      session.turn.outstanding.add(uuid);
    } else {
      session.turn = { turnId: input.turnId, outstanding: new Set([uuid]) };
      this.emit(session, { type: 'session.state.changed', status: 'running' });
      this.emit(session, { type: 'turn.started', turnId: input.turnId });
    }

    session.input.push(message);
    return { turnId: input.turnId, ...(steeredInto ? { steeredInto } : {}) };
  }

  async interruptTurn(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    try {
      await session.query.interrupt();
    } catch (cause) {
      throw new ProviderSessionError(PROVIDER, sessionId, 'Failed to interrupt the turn.', {
        cause,
      });
    }
  }

  async respondToRequest(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    const pending = session.pendingApprovals.get(requestId);
    if (!pending) {
      throw new ProviderSessionError(PROVIDER, sessionId, `Unknown request ${requestId}.`);
    }
    session.pendingApprovals.delete(requestId);
    pending.settle(decision);
  }

  async respondToUserInput(
    sessionId: string,
    requestId: string,
    answers: UserInputAnswers
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    const pending = session.pendingUserInputs.get(requestId);
    if (!pending) {
      throw new ProviderSessionError(PROVIDER, sessionId, `Unknown user input ${requestId}.`);
    }
    session.pendingUserInputs.delete(requestId);
    pending.settle(answers);
  }

  async setModel(sessionId: string, model: ModelSelection): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.applyModel(session, model);
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    this.shutdown(session, 'Session stopped.');
  }

  async stopAll(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      this.shutdown(session, 'Adapter stopped.');
    }
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ProviderSessionError(PROVIDER, sessionId, 'Unknown session.');
    return session;
  }

  private composeText(input: ProviderSendTurnInput): string {
    if (!input.attachments || input.attachments.length === 0) return input.text;
    const lines = input.attachments.map(
      (attachment) => `Attached file (${attachment.mimeType}): ${attachment.path}`
    );
    return `${input.text}\n\n${lines.join('\n')}`;
  }

  private async applyModel(session: SessionState, model: ModelSelection): Promise<void> {
    try {
      await session.query.setModel(model.id);
      const effort = effortFrom(model);
      if (effort) await session.query.applyFlagSettings({ effortLevel: effort });
    } catch (cause) {
      throw new ProviderSessionError(PROVIDER, session.sessionId, 'Failed to set the model.', {
        cause,
      });
    }
  }

  private emit(session: SessionState, body: EventBody): void {
    const event = {
      eventId: randomUUID(),
      provider: PROVIDER,
      sessionId: session.sessionId,
      createdAt: new Date().toISOString(),
      ...body,
    } as ProviderRuntimeEvent;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (cause) {
        this.logger?.error('Provider event listener threw.', { cause });
      }
    }
  }

  private pump(session: SessionState): void {
    const run = async () => {
      for await (const message of session.query) this.handleMessage(session, message);
    };

    run().then(
      () => this.shutdown(session, 'Claude Code stream ended.'),
      (cause) => {
        if (!session.stopping) {
          this.emit(session, {
            type: 'runtime.error',
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
        this.shutdown(session, 'Claude Code stream failed.');
      }
    );
  }

  private handleMessage(session: SessionState, message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          if (message.session_id !== session.nativeSessionId) {
            session.nativeSessionId = message.session_id;
            this.emit(session, {
              type: 'runtime.warning',
              message: `Claude Code chose session id ${message.session_id} instead of the requested one.`,
            });
          }
          this.emit(session, { type: 'session.state.changed', status: 'ready' });
        }
        return;
      case 'stream_event':
        this.handleStreamEvent(session, message.event, message.parent_tool_use_id);
        return;
      case 'assistant':
        this.handleAssistantMessage(session, message.message, message.parent_tool_use_id);
        return;
      case 'user':
        this.handleToolResults(session, message.message.content);
        return;
      case 'result':
        this.handleResult(session, message);
        return;
      default:
        return;
    }
  }

  private handleStreamEvent(
    session: SessionState,
    event: unknown,
    parentToolUseId: string | null
  ): void {
    if (parentToolUseId !== null || !isRecord(event)) return;
    const turnId = session.turn?.turnId;
    if (turnId === undefined) return;

    if (event.type === 'message_start' && isRecord(event.message)) {
      const id = event.message.id;
      session.streamMessageId = typeof id === 'string' ? id : null;
      session.textBlocks.clear();
      return;
    }
    const index = typeof event.index === 'number' ? event.index : null;
    if (index === null || session.streamMessageId === null) return;

    if (event.type === 'content_block_start' && isRecord(event.content_block)) {
      if (event.content_block.type !== 'text') return;
      session.textBlocks.set(index, {
        itemId: `${session.streamMessageId}#${index}`,
        text: '',
      });
      session.streamedMessageIds.add(session.streamMessageId);
      return;
    }

    if (event.type === 'content_block_delta' && isRecord(event.delta)) {
      const block = session.textBlocks.get(index);
      const delta = event.delta.text;
      if (!block || event.delta.type !== 'text_delta' || typeof delta !== 'string') return;
      block.text += delta;
      this.emit(session, { type: 'content.delta', turnId, itemId: block.itemId, delta });
      return;
    }

    if (event.type === 'content_block_stop') {
      const block = session.textBlocks.get(index);
      if (!block) return;
      session.textBlocks.delete(index);
      this.emit(session, {
        type: 'item.completed',
        turnId,
        item: {
          id: block.itemId,
          type: 'assistant_message',
          status: 'completed',
          title: truncate(block.text, 80),
          text: block.text,
        },
      });
    }
  }

  private handleAssistantMessage(
    session: SessionState,
    message: { id: string; content: unknown },
    parentToolUseId: string | null
  ): void {
    const turnId = session.turn?.turnId;
    if (turnId === undefined || !Array.isArray(message.content)) return;
    const streamed = session.streamedMessageIds.has(message.id);

    message.content.forEach((block, index) => {
      if (!isRecord(block)) return;
      if (block.type === 'text' && !streamed && parentToolUseId === null) {
        const text = typeof block.text === 'string' ? block.text : '';
        this.emit(session, {
          type: 'item.completed',
          turnId,
          item: {
            id: `${message.id}#a${index}`,
            type: 'assistant_message',
            status: 'completed',
            title: truncate(text, 80),
            text,
          },
        });
        return;
      }
      if (block.type === 'thinking' && parentToolUseId === null) {
        const text = typeof block.thinking === 'string' ? block.thinking : '';
        this.emit(session, {
          type: 'item.completed',
          turnId,
          item: {
            id: `${message.id}#t${index}`,
            type: 'reasoning',
            status: 'completed',
            title: truncate(text, 80),
            text,
          },
        });
        return;
      }
      if (block.type !== 'tool_use') return;
      const id = block.id;
      const name = block.name;
      if (typeof id !== 'string' || typeof name !== 'string') return;
      const toolInput = isRecord(block.input) ? block.input : {};
      const item: ProviderItem = {
        id,
        type: itemTypeForTool(name),
        status: 'in_progress',
        title: toolTitle(name, toolInput),
        toolName: toolNameForItem(name, toolInput),
        payload: toolInput,
      };
      session.toolItems.set(id, item);
      this.emit(session, {
        type: 'item.started',
        turnId,
        item,
        raw: { source: 'claude', payload: block },
      });
    });
  }

  private handleToolResults(session: SessionState, content: unknown): void {
    const turnId = session.turn?.turnId;
    if (turnId === undefined || !Array.isArray(content)) return;

    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue;
      const toolUseId = block.tool_use_id;
      if (typeof toolUseId !== 'string') continue;
      const started = session.toolItems.get(toolUseId);
      if (!started) continue;
      session.toolItems.delete(toolUseId);
      const status: ItemStatus = block.is_error === true ? 'failed' : 'completed';
      const text = textFromToolResultContent(block.content);
      this.emit(session, {
        type: 'item.completed',
        turnId,
        item: { ...started, status, ...(text !== undefined ? { text } : {}) },
        raw: { source: 'claude', payload: block },
      });
    }
  }

  private handleResult(session: SessionState, result: SDKResultMessage): void {
    const turn = session.turn;
    if (!turn) return;

    const consumed = [...(result.user_message_uuids ?? [])];
    const single = result.user_message_uuid;
    if (consumed.length === 0 && single !== undefined) consumed.push(single);

    const outcome = outcomeForResult(result);
    if (consumed.length === 0) {
      turn.outstanding.clear();
    } else {
      let matched = false;
      for (const uuid of consumed) {
        if (turn.outstanding.delete(uuid)) matched = true;
      }
      if (!matched) return;
    }
    if (outcome === 'completed' && turn.outstanding.size > 0) return;

    session.turn = null;
    session.textBlocks.clear();
    session.streamedMessageIds.clear();
    session.streamMessageId = null;
    const message = turnStatusMessage(result, outcome);
    if (outcome === 'error') {
      this.emit(session, { type: 'runtime.error', message: message ?? 'Claude turn failed.' });
    }
    this.emit(session, {
      type: 'turn.completed',
      turnId: turn.turnId,
      outcome,
      ...(message ? { message } : {}),
      raw: { source: 'claude', payload: result },
    });
    this.emit(session, { type: 'session.state.changed', status: 'ready' });
  }

  private makeCanUseTool(sessionId: string): CanUseTool {
    return async (toolName, toolInput, options) => {
      const session = this.sessions.get(sessionId);
      if (!session) return { behavior: 'deny', message: 'The session is gone.' };
      if (session.runtimeMode === 'full-access') return { behavior: 'allow' };
      if (session.registeredMcpPrefixes.some((prefix) => toolName.startsWith(prefix))) {
        return { behavior: 'allow' };
      }
      return this.requestApproval(session, toolName, toolInput, options);
    };
  }

  /**
   * `AskUserQuestion` is answered from a PreToolUse hook rather than from
   * `canUseTool`: the SDK skips `canUseTool` entirely under
   * `bypassPermissions` (it says so on stderr), while hooks run in every
   * permission mode, and a PreToolUse hook can rewrite the tool input the same
   * way a permission result can.
   */
  private makeAskUserQuestionHook(sessionId: string): HookCallback {
    return async (input, toolUseID, options) => {
      if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== ASK_USER_QUESTION) {
        return {};
      }
      const session = this.sessions.get(sessionId);
      if (!session) return {};
      const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
      const answers = await this.awaitUserAnswers(
        session,
        toolInput,
        toolUseID ?? input.tool_use_id,
        options.signal
      );
      if (answers === null) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { questions: toolInput.questions, answers },
        },
      };
    };
  }

  private awaitUserAnswers(
    session: SessionState,
    toolInput: Record<string, unknown>,
    requestId: string,
    signal: AbortSignal
  ): Promise<Record<string, string> | null> {
    const { questions, questionTextById } = parseAskUserQuestionInput(toolInput);
    const turnId = session.turn?.turnId;
    if (questions.length === 0 || turnId === undefined) return Promise.resolve(null);

    return new Promise<Record<string, string> | null>((resolve) => {
      const settle = (answers: UserInputAnswers | null) => {
        session.pendingUserInputs.delete(requestId);
        signal.removeEventListener('abort', onAbort);
        if (answers === null) {
          resolve(null);
          return;
        }
        this.emit(session, { type: 'user-input.resolved', requestId });
        resolve(buildAnswers(questions, questionTextById, answers));
      };
      const onAbort = () => settle(null);
      signal.addEventListener('abort', onAbort, { once: true });
      session.pendingUserInputs.set(requestId, { turnId, settle });
      this.emit(session, { type: 'user-input.requested', turnId, requestId, questions });
    });
  }

  private requestApproval(
    session: SessionState,
    toolName: string,
    toolInput: Record<string, unknown>,
    options: { toolUseID: string; signal: AbortSignal; suggestions?: PermissionUpdate[] } & {
      title?: string;
      description?: string;
    }
  ): Promise<PermissionResult> {
    const turnId = session.turn?.turnId;
    if (turnId === undefined) {
      return Promise.resolve({ behavior: 'deny', message: 'No turn is running.' });
    }
    const requestId = options.toolUseID;

    return new Promise<PermissionResult>((resolve) => {
      const settle = (decision: ApprovalDecision) => {
        session.pendingApprovals.delete(requestId);
        options.signal.removeEventListener('abort', onAbort);
        this.emit(session, { type: 'request.resolved', requestId, decision });
        if (decision === 'accept') {
          resolve({ behavior: 'allow' });
          return;
        }
        if (decision === 'acceptForSession') {
          const updatedPermissions = sessionScoped(options.suggestions);
          resolve({
            behavior: 'allow',
            ...(updatedPermissions.length > 0 ? { updatedPermissions } : {}),
          });
          return;
        }
        resolve({
          behavior: 'deny',
          message:
            decision === 'cancel'
              ? 'The user cancelled this request.'
              : 'The user declined this request. Do not retry it another way.',
          ...(decision === 'cancel' ? { interrupt: true } : {}),
        });
      };
      const onAbort = () => settle('cancel');
      options.signal.addEventListener('abort', onAbort, { once: true });
      session.pendingApprovals.set(requestId, { turnId, settle });
      this.emit(session, {
        type: 'request.opened',
        turnId,
        requestId,
        requestType: requestTypeForTool(toolName),
        title: options.title ?? toolTitle(toolName, toolInput),
        ...(options.description ? { detail: options.description } : {}),
        options: APPROVAL_OPTIONS,
        raw: { source: 'claude', payload: { toolName, toolInput } },
      });
    });
  }

  private shutdown(session: SessionState, reason: string): void {
    if (session.exited) return;
    session.exited = true;
    session.stopping = true;
    this.sessions.delete(session.sessionId);

    for (const [requestId, pending] of [...session.pendingApprovals]) {
      session.pendingApprovals.delete(requestId);
      pending.settle('cancel');
    }
    for (const [requestId, pending] of [...session.pendingUserInputs]) {
      session.pendingUserInputs.delete(requestId);
      pending.settle({});
      this.emit(session, { type: 'user-input.resolved', requestId });
    }

    const turn = session.turn;
    if (turn) {
      session.turn = null;
      this.emit(session, {
        type: 'turn.completed',
        turnId: turn.turnId,
        outcome: 'interrupted',
        message: reason,
      });
    }

    session.input.close();
    try {
      session.query.close();
    } catch (cause) {
      this.logger?.warn('Closing the Claude query threw.', {
        sessionId: session.sessionId,
        cause,
      });
    }

    this.emit(session, { type: 'session.state.changed', status: 'stopped' });
    this.emit(session, { type: 'session.exited', reason });
  }
}

function buildAnswers(
  questions: UserInputQuestion[],
  questionTextById: Map<string, string>,
  answers: UserInputAnswers
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const question of questions) {
    const text = questionTextById.get(question.id);
    if (text === undefined) continue;
    const answer = answers[question.id];
    if (answer === undefined) continue;
    result[text] = Array.isArray(answer) ? answer.join(', ') : answer;
  }
  return result;
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): ClaudeAdapter {
  return new ClaudeAdapter(options);
}
