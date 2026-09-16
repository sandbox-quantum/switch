import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { ModelChoice } from '@switch-console/shared/session-v1';
import type {
  McpServerSpec,
  ModelSelection,
  ProviderAdapter,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  RuntimeMode,
  TurnAttachment,
} from '../adapter';
import { ProviderSessionError } from '../adapter';
import type {
  ApprovalDecision,
  ProviderItem,
  ProviderRuntimeEvent,
  UserInputAnswers,
} from '../events';
import { noopLogger, type ProviderLogger } from '../transport/stdio-json-rpc';
import {
  type AntigravityEvent,
  itemTypeFor,
  parseLine,
  parseModels,
  type StepUpdate,
  titleFor,
} from './protocol';
import {
  allowMcpServers,
  registerWorkspaceMcpServers,
  restoreFile,
  revokeMcpAllowRules,
  workspaceMcpConfigPath,
} from './workspace-config';

const execute = promisify(execFile);
const PROVIDER = 'antigravity';
const STDERR_TAIL_LIMIT = 8_000;

/**
 * Where the Switch agent runtime writes a file fetched by the
 * `download_attachment` tool: `<root>/<runtime pid>/media/`. The per-session
 * directory is named after the runtime process, which the adapter never sees,
 * so the root is what can be granted.
 */
function switchSessionsRoot(env: Record<string, string>): string {
  return join(env.HOME || homedir(), '.switch', 'sessions');
}

/** A single `agent_response` or `tool` step of the running turn. */
interface Step {
  item: ProviderItem;
  started: boolean;
}

interface State {
  id: string;
  nativeId: string;
  cwd: string;
  /** Directories outside `cwd` the CLI was given access to, beyond `cwd` itself. */
  readable: Set<string>;
  env: Record<string, string>;
  runtimeMode: RuntimeMode;
  model?: ModelSelection;
  agentName?: string;
  context: string;
  child: ChildProcess | null;
  stderr: string;
  turn: string | null;
  queue: ProviderSendTurnInput[];
  /** Keyed by the step's own key, so parallel subagents in one step stay apart. */
  steps: Map<string, Step>;
  stopping: boolean;
  /** The process was killed on purpose; its exit ends the turn, not the session. */
  interrupting: boolean;
  /** Attachment paths handed to the running turn, to explain a read that was denied. */
  attachments: string[];
  models?: ModelChoice[];
  mcpServers: Record<string, McpServerSpec>;
  mcpConfigOriginal: string | null;
  mcpConfigPath: string;
  allowRulesPath: string;
  allowRules: string[];
}

type Emittable<T = ProviderRuntimeEvent> = T extends ProviderRuntimeEvent
  ? Omit<T, 'eventId' | 'provider' | 'sessionId' | 'createdAt'>
  : never;

export interface AntigravityAdapterOptions {
  binaryPath?: string;
  logger?: ProviderLogger;
  /** How long one `agy` turn may run before the CLI gives up. A Go duration. */
  printTimeout?: string;
}

/**
 * Drives the Antigravity CLI (`agy`) in stream-json print mode: one NDJSON
 * message per line on stdin runs a turn, and the process stays alive between
 * turns so the conversation keeps its context.
 *
 * Headless `agy` has no channel for permission prompts or clarifying questions,
 * so this adapter never opens a `request.opened` or a `user-input.requested`.
 * It also has no in-process cancel, so an interrupt kills the process and the
 * next turn resumes the same conversation with `--conversation`.
 */
export class AntigravityAdapter implements ProviderAdapter {
  readonly provider = PROVIDER;
  readonly capabilities = {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: false,
    userInput: false,
  };
  private readonly sessions = new Map<string, State>();
  private readonly listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly logger: ProviderLogger;
  /** Serializes edits to the machine-wide settings file across sessions. */
  private settingsWrites: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: AntigravityAdapterOptions = {}) {
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
    const state: State = {
      id: input.sessionId,
      nativeId: input.resume?.nativeSessionId ?? '',
      cwd,
      // Outside `full-access` the CLI reads only what it was given at launch,
      // and a Switch tool can put a file under the runtime's session directory
      // at any point in the turn that asked for it — too late to grant then.
      readable: new Set(
        input.runtimeMode === 'full-access' ? [] : [switchSessionsRoot(input.env)]
      ),
      env: input.env,
      runtimeMode: input.runtimeMode,
      ...(input.model ? { model: input.model } : {}),
      ...(input.agentName ? { agentName: input.agentName } : {}),
      context: input.systemContext ?? '',
      child: null,
      stderr: '',
      turn: null,
      queue: [],
      steps: new Map(),
      stopping: false,
      interrupting: false,
      attachments: [],
      mcpServers: input.mcpServers,
      mcpConfigOriginal: null,
      mcpConfigPath: workspaceMcpConfigPath(cwd),
      allowRulesPath: '',
      allowRules: [],
    };
    this.sessions.set(state.id, state);
    this.emit(state, { type: 'session.state.changed', status: 'starting' });
    try {
      await this.registerMcp(state);
      await this.spawnProcess(state);
      this.emit(state, { type: 'session.started', nativeSessionId: state.nativeId });
      if (input.runtimeMode === 'approval-required')
        this.emit(state, {
          type: 'runtime.warning',
          message:
            'Antigravity cannot ask for approval without a terminal, so every tool that would need one is denied automatically. Switch to auto-accept edits or full access to let this session act.',
        });
      this.emit(state, { type: 'session.state.changed', status: 'ready' });
      return { provider: PROVIDER, sessionId: state.id, nativeSessionId: state.nativeId };
    } catch (cause) {
      await this.releaseConfig(state);
      state.child?.kill('SIGKILL');
      this.sessions.delete(state.id);
      throw new ProviderSessionError(
        PROVIDER,
        state.id,
        `Could not start the Antigravity CLI: ${String(cause)}${state.stderr ? `\n${state.stderr}` : ''}`,
        { cause }
      );
    }
  }

  private argumentsFor(state: State): string[] {
    const args = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--print-timeout',
      this.options.printTimeout ?? '2h',
      '--add-dir',
      state.cwd,
    ];
    for (const directory of state.readable) args.push('--add-dir', directory);
    if (state.runtimeMode === 'full-access') args.push('--dangerously-skip-permissions');
    else if (state.runtimeMode === 'auto-accept-edits') args.push('--mode', 'accept-edits');
    if (state.model) {
      args.push('--model', state.model.id);
      const effort = state.model.options?.effort;
      if (effort) args.push('--effort', effort);
    }
    if (state.agentName) args.push('--agent', state.agentName);
    if (state.nativeId) args.push('--conversation', state.nativeId);
    return args;
  }

  /**
   * Starts `agy` and resolves once its `init` line names the conversation. A
   * respawn passes `--conversation`, so the same native id survives a kill.
   */
  private spawnProcess(state: State): Promise<void> {
    const child = spawn(this.options.binaryPath ?? 'agy', this.argumentsFor(state), {
      cwd: state.cwd,
      env: state.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    state.child = child;
    state.stderr = '';
    let settle: ((error?: Error) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      settle = (error) => {
        settle = null;
        if (error) reject(error);
        else resolve();
      };
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      state.stderr = `${state.stderr}${chunk}`.slice(-STDERR_TAIL_LIMIT);
    });
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      const event = parseLine(line);
      if (!event) return;
      if (event.event === 'init') {
        if (event.conversation_id) state.nativeId = event.conversation_id;
        settle?.();
        return;
      }
      try {
        this.handle(state, event);
      } catch (cause) {
        this.logger.error('Antigravity event handling failed', { error: String(cause) });
      }
    });
    child.on('error', (error) => settle?.(error));
    child.on('exit', (code, signal) => {
      if (state.child !== child) return;
      state.child = null;
      const reason = signal
        ? `The Antigravity CLI was terminated with ${signal}.`
        : `The Antigravity CLI exited with code ${code}.`;
      settle?.(new Error(`${reason}${state.stderr ? ` ${state.stderr.trim()}` : ''}`));
      this.processGone(state, reason);
    });
    return ready;
  }

  /**
   * An exit ends the running turn. It only ends the session when nobody asked
   * for it — a deliberate interrupt leaves the session ready to respawn.
   */
  private processGone(state: State, reason: string): void {
    if (state.interrupting) {
      state.interrupting = false;
      this.complete(state, 'interrupted', 'Interrupted.');
      return;
    }
    if (state.stopping) return;
    this.exited(state.id, reason);
  }

  async sendTurn(input: ProviderSendTurnInput) {
    const state = this.require(input.sessionId);
    state.queue.push(input);
    if (!state.turn) void this.drain(state);
    return { turnId: input.turnId };
  }

  private async drain(state: State): Promise<void> {
    if (state.turn || state.stopping || !this.hasSession(state.id)) return;
    const input = state.queue.shift();
    if (!input) return;
    state.turn = input.turnId;
    state.steps.clear();
    this.emit(state, { type: 'turn.started', turnId: input.turnId });
    this.emit(state, { type: 'session.state.changed', status: 'running' });
    try {
      if (input.model && input.model.id !== state.model?.id)
        await this.setModel(state.id, input.model);
      state.attachments = (input.attachments ?? []).map((attachment) => attachment.path);
      await this.makeAttachmentsReadable(state, input.attachments ?? []);
      if (!state.child) await this.spawnProcess(state);
      const blocks: Array<{ type: string; text: string }> = [];
      const prefix = state.context ? `${state.context}\n\n` : '';
      state.context = '';
      blocks.push({ type: 'text', text: `${prefix}${input.text}` });
      for (const attachment of input.attachments ?? [])
        blocks.push({
          type: 'text',
          text: `Attached file (${attachment.mimeType}): ${attachment.path}`,
        });
      state.child!.stdin!.write(
        `${JSON.stringify({ event: 'user', message: { content: blocks } })}\n`
      );
    } catch (cause) {
      if (state.turn === input.turnId) this.complete(state, 'error', String(cause));
    }
  }

  /**
   * Attachments are staged outside the working directory, and outside
   * `full-access` the CLI denies reading a path it was not given. The grant is
   * read at launch only — adding it to a live process changes nothing — so a
   * turn that brings a new directory respawns onto the same conversation first.
   */
  private async makeAttachmentsReadable(
    state: State,
    attachments: readonly TurnAttachment[]
  ): Promise<void> {
    if (state.runtimeMode === 'full-access' || attachments.length === 0) return;
    let added = false;
    for (const attachment of attachments) {
      let directory = dirname(attachment.path);
      try {
        directory = await realpath(directory);
      } catch {
        // A path the host staged but that is already gone stays as written; the
        // read will fail loudly rather than silently widening access.
      }
      if (directory === state.cwd || state.readable.has(directory)) continue;
      state.readable.add(directory);
      added = true;
    }
    if (!added) return;
    const child = state.child;
    if (!child) return;
    state.child = null;
    child.kill('SIGKILL');
  }

  private handle(state: State, event: AntigravityEvent): void {
    // An interrupted turn is settled by the exit, so that the next turn is not
    // written to the stdin of a process that is already going away.
    if (state.interrupting) return;
    if (event.step_update) this.step(state, event.step_update);
    else if (event.event === 'result' && event.result) {
      const denied = event.result.denied_actions ?? [];
      if (denied.length > 0)
        this.emit(state, {
          type: 'runtime.warning',
          message: `Antigravity denied ${denied.map((action) => action.display_name ?? action.action ?? 'a tool').join(', ')} because headless mode cannot ask for permission.`,
        });
      if (state.attachments.length > 0 && denied.some((action) => action.action === 'read_file'))
        this.emit(state, {
          type: 'runtime.warning',
          message: `Antigravity was refused a file read this turn, so it may not have opened ${state.attachments.join(', ')}.`,
        });
      const failed = event.result.status === 'ERROR';
      this.complete(
        state,
        failed ? 'error' : 'completed',
        failed ? (event.result.error ?? 'Antigravity reported an error.') : undefined
      );
    }
  }

  private step(state: State, update: StepUpdate): void {
    const turnId = state.turn;
    const index = update.step_index;
    if (!turnId || index === undefined) return;
    if (update.step_type === 'agent_response')
      return this.assistantStep(state, turnId, index, update);
    // Delegation is its own step type, not a tool call with a subagent name.
    if (update.step_type === 'subagent') return this.subagentStep(state, turnId, index, update);
    if (update.step_type !== 'tool') return;
    const toolName = update.tool_name ?? update.tool_info?.name ?? 'tool';
    const existing = state.steps.get(String(index));
    const info = update.tool_info;
    const failure = info?.error?.message;
    const item: ProviderItem = {
      id: existing?.item.id ?? `${turnId}-step-${index}`,
      type: existing?.item.type ?? itemTypeFor(toolName),
      status:
        update.state === 'ERROR' ? 'failed' : update.state === 'DONE' ? 'completed' : 'in_progress',
      title: titleFor(toolName, info?.parameters) || existing?.item.title || toolName,
      toolName,
      ...((failure ?? info?.output ?? existing?.item.text)
        ? { text: failure ?? info?.output ?? existing?.item.text }
        : {}),
      ...(info?.parameters ? { payload: info.parameters } : {}),
    };
    state.steps.set(String(index), { item, started: true });
    const terminal = update.state === 'DONE' || update.state === 'ERROR';
    this.emit(state, {
      type: terminal ? 'item.completed' : existing?.started ? 'item.updated' : 'item.started',
      turnId,
      item,
    });
  }

  private subagentStep(state: State, turnId: string, index: number, update: StepUpdate): void {
    const terminal = update.state === 'DONE' || update.state === 'ERROR';
    const children = update.subagent_info?.subagents ?? [];
    children.forEach((child, position) => {
      const key = `${index}-${position}`;
      const item: ProviderItem = {
        id: `${turnId}-step-${key}`,
        type: 'subagent',
        status: update.state === 'ERROR' ? 'failed' : terminal ? 'completed' : 'in_progress',
        title: child.role ?? child.type_name ?? 'Subagent',
        toolName: child.type_name ?? update.tool_name ?? 'invoke_subagent',
        ...(child.conversation_id ? { nativeChildId: child.conversation_id } : {}),
        ...(child.initial_prompt ? { text: child.initial_prompt } : {}),
      };
      const existing = state.steps.get(key);
      state.steps.set(key, { item, started: true });
      this.emit(state, {
        type: terminal ? 'item.completed' : existing?.started ? 'item.updated' : 'item.started',
        turnId,
        item,
      });
    });
  }

  private assistantStep(state: State, turnId: string, index: number, update: StepUpdate): void {
    const delta = update.text_delta ?? '';
    const existing = state.steps.get(String(index));
    if (!delta && !existing) return;
    const id = existing?.item.id ?? `${turnId}-step-${index}`;
    const text = `${existing?.item.text ?? ''}${delta}`;
    const item: ProviderItem = {
      id,
      type: 'assistant_message',
      status: update.state === 'DONE' ? 'completed' : 'in_progress',
      title: 'Assistant',
      text,
    };
    if (!existing) this.emit(state, { type: 'item.started', turnId, item: { ...item, text: '' } });
    state.steps.set(String(index), { item, started: true });
    if (delta) this.emit(state, { type: 'content.delta', turnId, itemId: id, delta });
    if (update.state === 'DONE') this.emit(state, { type: 'item.completed', turnId, item });
  }

  private complete(
    state: State,
    outcome: 'completed' | 'interrupted' | 'error',
    message?: string
  ): void {
    const turnId = state.turn;
    if (!turnId) return;
    state.turn = null;
    for (const step of state.steps.values())
      if (step.item.status === 'in_progress')
        this.emit(state, {
          type: 'item.completed',
          turnId,
          item: {
            ...step.item,
            status: outcome === 'completed' ? 'completed' : 'failed',
          },
        });
    state.steps.clear();
    this.emit(state, { type: 'turn.completed', turnId, outcome, ...(message ? { message } : {}) });
    this.emit(state, {
      type: 'session.state.changed',
      status: state.stopping ? 'stopped' : outcome === 'error' ? 'error' : 'ready',
    });
    void this.drain(state);
  }

  /**
   * `agy` has no cancel message: SIGINT ends the process and the turn with it.
   * The conversation id survives, so the next turn respawns onto it.
   */
  async interruptTurn(id: string): Promise<void> {
    const state = this.require(id);
    if (!state.turn) return;
    if (!state.child) {
      this.complete(state, 'interrupted', 'Interrupted.');
      return;
    }
    state.interrupting = true;
    state.child.kill('SIGINT');
  }

  async listModels(id: string): Promise<ModelChoice[]> {
    const state = this.require(id);
    if (state.models) return state.models;
    const { stdout } = await execute(this.options.binaryPath ?? 'agy', ['models'], {
      cwd: state.cwd,
      env: state.env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    state.models = parseModels(stdout).map((model) => ({ ...model, options: {} }));
    return state.models;
  }

  /** The model is a launch flag, so a change takes effect on the next turn's process. */
  async setModel(id: string, model: ModelSelection): Promise<void> {
    const state = this.require(id);
    if (state.model?.id === model.id && state.model?.options?.effort === model.options?.effort)
      return;
    state.model = model;
    const child = state.child;
    if (!child) return;
    // Dropping the reference first tells the exit handler this was deliberate.
    state.child = null;
    child.kill('SIGKILL');
  }

  async respondToRequest(
    id: string,
    _requestId: string,
    _decision: ApprovalDecision
  ): Promise<void> {
    throw new ProviderSessionError(
      PROVIDER,
      id,
      'Antigravity cannot ask for approval in headless mode, so it never opens a request to answer.'
    );
  }

  async respondToUserInput(
    id: string,
    _requestId: string,
    _answers: UserInputAnswers
  ): Promise<void> {
    throw new ProviderSessionError(
      PROVIDER,
      id,
      'Antigravity skips ask_question in headless mode; ask in the conversation instead.'
    );
  }

  private async registerMcp(state: State): Promise<void> {
    const names = Object.keys(state.mcpServers);
    if (names.length === 0) return;
    state.mcpConfigOriginal = await registerWorkspaceMcpServers({
      cwd: state.cwd,
      servers: state.mcpServers,
      env: state.env,
    });
    if (state.runtimeMode === 'full-access') return;
    const home = state.env.HOME;
    if (!home) {
      this.emit(state, {
        type: 'runtime.warning',
        message:
          'No HOME in the session environment, so the MCP servers could not be allow-listed. Antigravity will deny them unless the session runs with full access.',
      });
      return;
    }
    const granted = await this.queueSettings(() => allowMcpServers({ home, names }));
    state.allowRulesPath = granted.path;
    state.allowRules = granted.added;
  }

  private queueSettings<T>(work: () => Promise<T>): Promise<T> {
    const next = this.settingsWrites.then(work, work);
    this.settingsWrites = next.catch(() => {});
    return next;
  }

  private async releaseConfig(state: State): Promise<void> {
    if (Object.keys(state.mcpServers).length === 0) return;
    const inUse = new Set<string>();
    for (const other of this.sessions.values())
      if (other !== state) for (const rule of other.allowRules) inUse.add(rule);
    const drop = state.allowRules.filter((rule) => !inUse.has(rule));
    state.allowRules = [];
    try {
      await restoreFile(state.mcpConfigPath, state.mcpConfigOriginal);
      if (state.allowRulesPath)
        await this.queueSettings(() => revokeMcpAllowRules(state.allowRulesPath, drop));
    } catch (cause) {
      this.logger.warn('Antigravity session configuration was not fully removed', {
        error: String(cause),
      });
    }
  }

  async stopSession(id: string): Promise<void> {
    const state = this.sessions.get(id);
    if (!state) return;
    state.stopping = true;
    state.interrupting = false;
    const child = state.child;
    state.child = null;
    child?.kill('SIGKILL');
    await this.releaseConfig(state);
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
    for (const input of state.queue.splice(0))
      this.emit(state, {
        type: 'turn.completed',
        turnId: input.turnId,
        outcome: 'error',
        message: reason,
      });
    this.sessions.delete(id);
    if (!stopping) void this.releaseConfig(state);
    this.emit(state, { type: 'session.state.changed', status: 'stopped' });
    this.emit(state, { type: 'session.exited', reason });
  }

  private require(id: string): State {
    const state = this.sessions.get(id);
    if (!state || state.stopping)
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
        this.logger.error('Antigravity event listener failed', { error: String(cause) });
      }
    }
  }
}

export function createAntigravityAdapter(
  options: AntigravityAdapterOptions = {}
): AntigravityAdapter {
  return new AntigravityAdapter(options);
}
