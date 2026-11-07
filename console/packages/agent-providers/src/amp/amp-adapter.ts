import type { ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { ModelChoice } from '@switch-console/shared/session-v1';
import {
  type ProviderAdapter,
  type ProviderCapabilities,
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
  ItemStatus,
  ProviderItem,
  ProviderRuntimeEvent,
  TokenUsage,
  TurnOutcome,
  UserInputAnswers,
} from '../events';
import { execProvider, spawnProvider, stopProvider } from '../provider-process';
import { noopLogger, type ProviderLogger } from '../transport/stdio-json-rpc';
import { mergeUsage } from '../usage';
import {
  AMP_MODES,
  isBackgroundSubagentCall,
  isRecord,
  itemTypeForTool,
  textFromToolResultContent,
  toolPolicy,
  toolTitle,
  truncate,
} from './amp-mapping';
import { AMP_PLUGIN_ENDPOINT_VARIABLE, AMP_PLUGIN_TOKEN_VARIABLE } from './approval-plugin';
import {
  ampSessionDirectory,
  ampSessionsRoot,
  prepareAmpSessionHome,
  removeAmpSessionHome,
} from './home';
import {
  type AmpAgentEndStatus,
  type AmpControlCommand,
  AmpPluginBridge,
  type AmpPluginSessionHandler,
  type AmpToolCallRequest,
  type AmpToolDecision,
} from './plugin-bridge';

const PROVIDER = 'amp';

export interface AmpTimeouts {
  /** How long the thread may take to start (its `init` line) after the first message of a run. */
  initMs: number;
  /** How long the approval plugin may take to call in once Amp has started. */
  pluginReadyMs: number;
  /** How long a cancel through the plugin may take before the process is stopped instead. */
  cancelMs: number;
  /** After the model stopped, how long to wait for the plugin's `agent.end` before closing the turn. */
  endGraceMs: number;
  /** How long one plugin request waits for a decision before it is told to ask again. */
  decisionWaitMs: number;
  /** How long the plugin's control poll is held before it is answered with nothing. */
  controlWaitMs: number;
}

export const AMP_TIMEOUTS: AmpTimeouts = {
  initMs: 90_000,
  pluginReadyMs: 45_000,
  cancelMs: 15_000,
  endGraceMs: 10_000,
  decisionWaitMs: 20_000,
  controlWaitMs: 25_000,
};

const STDERR_TAIL_LIMIT = 8_000;

export const AMP_SIGN_IN_REQUIRED = 'Sign in on the execution machine with amp login.';

export const ampPluginNotLoaded = (mode: RuntimeMode) =>
  `Amp did not load the Switch approval plugin, which is what makes it ask before running a tool. In ${mode} mode the session cannot run without it: tools would run unasked. Check that this Amp runs plugins (amp plugins list) and that \`.amp/plugins\` in the working directory holds nothing that stops it.`;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export interface AmpAdapterOptions {
  /** Defaults to `amp` on PATH. */
  binaryPath?: string;
  logger?: ProviderLogger;
  /** Where sessions keep their Amp configuration; defaults under the user's state directory. */
  sessionsRoot?: string;
  timeouts?: Partial<AmpTimeouts>;
}

/** `Omit` collapses a union, so peel the metadata off each member instead. */
type EmittableEvent<T = ProviderRuntimeEvent> = T extends ProviderRuntimeEvent
  ? Omit<T, 'eventId' | 'provider' | 'sessionId' | 'createdAt'>
  : never;

interface PendingApproval {
  requestId: string;
  toolUseID: string;
  /** What an `acceptForSession` remembers: the command for a shell tool, else the tool. */
  sessionKey: string;
  decision: AmpToolDecision | null;
  waiters: Set<(decision: AmpToolDecision) => void>;
}

interface AmpProcess {
  child: ChildProcess;
  alive: boolean;
  stderrTail: string;
  exited: boolean;
  pluginReady: boolean;
  readyWaiters: Set<{ resolve: () => void; reject: (error: Error) => void }>;
  /** The `init` line has arrived: the thread is running this run's first message. */
  initialized: boolean;
  /** Armed by the first message written to the run, which the thread must start before it fires. */
  initTimer?: ReturnType<typeof setTimeout>;
}

interface Turn {
  turnId: string;
  /** The model has stopped; the plugin's `agent.end` closes the turn, or this does. */
  endGrace?: ReturnType<typeof setTimeout>;
  /** A cancel is on its way through the plugin; the process is stopped if it is late. */
  cancelTimer?: ReturnType<typeof setTimeout>;
}

interface AmpSessionState {
  sessionId: string;
  cwd: string;
  runtimeMode: RuntimeMode;
  /** The environment Amp runs with, the plugin's endpoint and token included. */
  env: Record<string, string>;
  threadId: string;
  mode: string | undefined;
  /** No message has reached the thread yet, so the run that sends one sets its mode. */
  threadFresh: boolean;
  directory: string;
  settingsFile: string;
  token: string;
  process: AmpProcess | null;
  /** The process is being stopped on purpose; its exit is not a failure. */
  expectingExit: boolean;
  stopping: boolean;
  exited: boolean;
  /** The Switch skill and the rest go into the thread's first message. */
  pendingContext: string | undefined;
  turn: Turn | null;
  /** Messages written to Amp whose turn has not been seen starting yet, by their text. */
  awaitingTurns: { text: string; turnId: string }[];
  toolItems: Map<string, ProviderItem>;
  backgroundSubagents: Set<string>;
  declinedToolUses: Set<string>;
  approvals: Map<string, PendingApproval>;
  approvalsByToolUse: Map<string, PendingApproval>;
  /** Tools (or commands) allowed for the session by an `acceptForSession`. */
  sessionAllowed: Set<string>;
  controlQueue: AmpControlCommand[];
  controlWaiters: Set<(command: AmpControlCommand) => void>;
  autoApprovedMcpServers: Set<string>;
  connectorMcpServers: Set<string>;
  unreportedUsage: TokenUsage[];
  context: { usedTokens: number; windowTokens: number | null } | undefined;
  followUps: number;
}

function approvalOptions(decisions: ApprovalDecision[]): ApprovalOption[] {
  const labels: Record<ApprovalDecision, string> = {
    accept: 'Allow once',
    acceptForSession: 'Allow for this session',
    decline: 'Reject',
    cancel: 'Cancel',
  };
  return decisions.map((decision) => ({ decision, label: labels[decision] }));
}

function outcomeOf(status: AmpAgentEndStatus): TurnOutcome {
  switch (status) {
    case 'done':
      return 'completed';
    case 'cancelled':
      return 'interrupted';
    default:
      return 'error';
  }
}

/** `stop_reason` values after which the model is not asking for a tool and the turn is over. */
const TURN_ENDING_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'refusal']);

/**
 * Amp through `amp threads continue <thread> -x --stream-json --stream-json-input`:
 * one long-lived process per session reading user messages from stdin, with a
 * Switch plugin loaded beside it (`approval-plugin.ts`) that asks this adapter
 * before every tool runs, reports turn boundaries, and cancels a turn on
 * request. The thread is created first with `amp threads new`, because the
 * stream says nothing, not even its `init` line, until a first message is in.
 */
export class AmpAdapter implements ProviderAdapter {
  readonly provider = PROVIDER;
  readonly capabilities: ProviderCapabilities = {
    modelSwitchInSession: false,
    steering: true,
    resume: true,
    approvals: true,
    userInput: false,
  };

  private readonly sessions = new Map<string, AmpSessionState>();
  private readonly listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly binaryPath: string;
  private readonly logger: ProviderLogger;
  private readonly sessionsRoot: string | undefined;
  private readonly timeouts: AmpTimeouts;
  private readonly bridge = new AmpPluginBridge();
  private requestSeq = 0;

  constructor(options: AmpAdapterOptions = {}) {
    this.binaryPath = options.binaryPath ?? 'amp';
    this.logger = options.logger ?? noopLogger;
    this.sessionsRoot = options.sessionsRoot;
    this.timeouts = { ...AMP_TIMEOUTS, ...options.timeouts };
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  hasBackgroundWork(sessionId: string): boolean {
    return (this.sessions.get(sessionId)?.backgroundSubagents.size ?? 0) > 0;
  }

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    if (this.sessions.has(input.sessionId))
      throw new ProviderSessionError(PROVIDER, input.sessionId, 'session already started');
    const endpoint = await this.bridge.endpoint();
    const token = randomBytes(24).toString('hex');
    const directory = ampSessionDirectory(
      this.sessionsRoot ?? ampSessionsRoot(input.env),
      input.sessionId
    );
    let home: { configHome: string; settingsFile: string };
    try {
      home = await prepareAmpSessionHome({
        directory,
        env: input.env,
        mcpServers: input.mcpServers,
        sessionEnv: input.env,
      });
    } catch (cause) {
      throw new ProviderSessionError(
        PROVIDER,
        input.sessionId,
        `could not prepare the session's Amp configuration: ${String(cause)}`,
        { cause }
      );
    }
    const state: AmpSessionState = {
      sessionId: input.sessionId,
      cwd: input.cwd,
      runtimeMode: input.runtimeMode,
      env: {
        ...input.env,
        XDG_CONFIG_HOME: home.configHome,
        AMP_SKIP_UPDATE_CHECK: '1',
        [AMP_PLUGIN_ENDPOINT_VARIABLE]: endpoint,
        [AMP_PLUGIN_TOKEN_VARIABLE]: token,
      },
      threadId: input.resume?.nativeSessionId ?? '',
      mode: input.model?.id || undefined,
      threadFresh: !input.resume,
      directory,
      settingsFile: home.settingsFile,
      token,
      process: null,
      expectingExit: false,
      stopping: false,
      exited: false,
      pendingContext: input.resume ? undefined : input.systemContext || undefined,
      turn: null,
      awaitingTurns: [],
      toolItems: new Map(),
      backgroundSubagents: new Set(),
      declinedToolUses: new Set(),
      approvals: new Map(),
      approvalsByToolUse: new Map(),
      sessionAllowed: new Set(),
      controlQueue: [],
      controlWaiters: new Set(),
      autoApprovedMcpServers: new Set(
        Object.keys(input.mcpServers).filter((name) => !input.connectorMcpServers.includes(name))
      ),
      connectorMcpServers: new Set(input.connectorMcpServers),
      unreportedUsage: [],
      context: undefined,
      followUps: 0,
    };
    this.sessions.set(input.sessionId, state);
    this.bridge.register(token, this.pluginHandler(state));
    this.emit(state, { type: 'session.state.changed', status: 'starting' });
    try {
      if (!state.threadId) state.threadId = await this.createThread(state);
      await this.spawn(state);
    } catch (cause) {
      if (this.sessions.get(input.sessionId) === state) this.sessions.delete(input.sessionId);
      this.bridge.unregister(token);
      await removeAmpSessionHome(directory).catch(() => {});
      throw new ProviderSessionError(
        PROVIDER,
        input.sessionId,
        `could not start amp: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause }
      );
    }
    this.emit(state, { type: 'session.started', nativeSessionId: state.threadId });
    this.emit(state, { type: 'session.state.changed', status: 'ready' });
    return { sessionId: input.sessionId, nativeSessionId: state.threadId, provider: PROVIDER };
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    const state = this.requireSession(input.sessionId);
    if (!state.process?.alive) {
      try {
        await this.spawn(state);
      } catch (cause) {
        throw new ProviderSessionError(
          PROVIDER,
          input.sessionId,
          `could not restart amp on thread ${state.threadId}: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause }
        );
      }
    }
    if (input.model?.id && input.model.id !== (state.mode ?? input.model.id)) {
      const message = `Amp fixes a thread's mode at its first message, so this conversation stays on ${state.mode ?? 'its mode'}; ${input.model.id} applies to a fresh conversation.`;
      this.logger.warn(message, { sessionId: state.sessionId });
      this.emit(state, { type: 'runtime.warning', message });
    }
    const content = await this.composeContent(state, input);
    const text = content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
    if (state.turn) {
      state.awaitingTurns.push({ text, turnId: input.turnId });
      this.write(state, { type: 'user', steer: true, message: { role: 'user', content } });
      return { turnId: input.turnId };
    }
    state.turn = { turnId: input.turnId };
    state.awaitingTurns.push({ text, turnId: input.turnId });
    this.write(state, { type: 'user', message: { role: 'user', content } });
    this.armInitWatchdog(state);
    state.pendingContext = undefined;
    this.emit(state, { type: 'session.state.changed', status: 'running' });
    this.emit(state, { type: 'turn.started', turnId: input.turnId });
    return { turnId: input.turnId };
  }

  async interruptTurn(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    const turn = state.turn;
    if (!turn || turn.cancelTimer) return;
    if (state.process?.alive && state.process.pluginReady) {
      this.sendControl(state, { kind: 'cancel', threadId: state.threadId });
      turn.cancelTimer = setTimeout(() => {
        this.logger.warn('Amp did not cancel the turn through the plugin; stopping the process.', {
          sessionId,
        });
        this.stopProcessForInterrupt(state);
      }, this.timeouts.cancelMs);
      turn.cancelTimer.unref();
      return;
    }
    this.stopProcessForInterrupt(state);
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
    this.settleApproval(state, pending, decision);
  }

  async respondToUserInput(
    sessionId: string,
    requestId: string,
    _answers: UserInputAnswers
  ): Promise<void> {
    throw new ProviderSessionError(PROVIDER, sessionId, `no open question ${requestId}`);
  }

  async listModels(sessionId: string): Promise<ModelChoice[]> {
    this.requireSession(sessionId);
    return AMP_MODES.map((mode) => ({ id: mode.id, label: mode.label, options: {} }));
  }

  async contextUsage(
    sessionId: string
  ): Promise<{ usedTokens: number; windowTokens: number | null } | null> {
    return this.requireSession(sessionId).context ?? null;
  }

  async stopSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.stopping = true;
    this.cancelPending(state, 'The session is stopping.');
    const process = state.process;
    if (process?.alive) {
      state.expectingExit = true;
      await this.endProcess(process);
    }
    await removeAmpSessionHome(state.directory).catch((error: unknown) =>
      this.logger.warn('Could not remove the session’s Amp configuration.', {
        sessionId,
        error: String(error),
      })
    );
    this.finishSession(state, 'stopped by Switch');
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.stopSession(sessionId)));
    await this.bridge.close();
  }

  /**
   * The command line a session's Amp runs with. Every run continues the
   * session's thread; a thread's mode is fixed by its first message, so
   * `--mode` goes with the run that sends it.
   */
  launchArgs(
    state: Pick<AmpSessionState, 'threadId' | 'mode' | 'settingsFile' | 'threadFresh'>
  ): string[] {
    return [
      'threads',
      'continue',
      state.threadId,
      ...(state.threadFresh && state.mode ? ['--mode', state.mode] : []),
      '--visibility',
      'private',
      '--no-archive-after-execute',
      '--settings-file',
      state.settingsFile,
      '--plugin-ready-timeout',
      '60',
      '--stream-json',
      '--stream-json-input',
      '--execute',
    ];
  }

  /**
   * Creates the session's thread, empty, so that its id is known before
   * anything is said: `amp threads new` prints the thread's URL and makes no
   * model call. A mode given here would not stick; the first run sets it.
   */
  private async createThread(state: AmpSessionState): Promise<string> {
    let output: { stdout: string; stderr: string };
    try {
      output = await execProvider(
        this.binaryPath,
        ['threads', 'new', '--visibility', 'private', '--settings-file', state.settingsFile],
        { cwd: state.cwd, env: state.env, timeout: this.timeouts.initMs }
      );
    } catch (error) {
      const stderr =
        typeof (error as { stderr?: unknown }).stderr === 'string'
          ? (error as { stderr: string }).stderr.trim()
          : '';
      throw new Error(
        `amp threads new failed: ${stderr || (error instanceof Error ? error.message : String(error))}`
      );
    }
    const match = /\bT-[0-9a-f-]+/i.exec(output.stdout);
    if (!match) {
      const printed = `${output.stdout}\n${output.stderr}`.trim().slice(0, 500);
      throw new Error(`amp threads new printed no thread id: ${printed || 'nothing'}`);
    }
    return match[0];
  }

  private async spawn(state: AmpSessionState): Promise<void> {
    const child = spawnProvider(this.binaryPath, this.launchArgs(state), {
      cwd: state.cwd,
      env: state.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const process: AmpProcess = {
      child,
      alive: true,
      exited: false,
      stderrTail: '',
      pluginReady: false,
      readyWaiters: new Set(),
      initialized: false,
    };
    state.process = process;
    state.expectingExit = false;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) throw new Error('amp was spawned without stdio pipes');
    createInterface({ input: stdout }).on('line', (line) => {
      if (state.process !== process || state.expectingExit) return;
      this.handleLine(state, line);
    });
    stderr.on('data', (chunk: Buffer) => {
      process.stderrTail = `${process.stderrTail}${chunk.toString('utf8')}`.slice(
        -STDERR_TAIL_LIMIT
      );
    });
    child.on('error', (error) => this.handleExit(state, process, `spawn failed: ${error.message}`));
    child.on('exit', (code, signal) =>
      this.handleExit(
        state,
        process,
        `amp exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`
      )
    );

    if (state.runtimeMode !== 'full-access') await this.awaitPlugin(state, process);
  }

  private awaitPlugin(state: AmpSessionState, process: AmpProcess): Promise<void> {
    if (process.pluginReady) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        process.readyWaiters.delete(waiter);
        this.abandonProcess(state, process);
        reject(new Error(ampPluginNotLoaded(state.runtimeMode)));
      }, this.timeouts.pluginReadyMs);
      timer.unref();
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      process.readyWaiters.add(waiter);
    });
  }

  /** Stops a process a start gave up on, so its exit is not reported as a failure. */
  private abandonProcess(state: AmpSessionState, process: AmpProcess): void {
    if (!process.alive) return;
    state.expectingExit = true;
    void this.endProcess(process).catch(() => {});
  }

  /**
   * The thread must start (its `init` line) within `initMs` of the first
   * message written to a run. A run that stays silent is stopped and the turn
   * fails, with whatever Amp wrote to stderr; the next turn starts a new run.
   */
  private armInitWatchdog(state: AmpSessionState): void {
    const process = state.process;
    if (!process || process.initialized || process.initTimer) return;
    process.initTimer = setTimeout(() => {
      process.initTimer = undefined;
      if (!process.alive || process.initialized) return;
      const tail = process.stderrTail.trim();
      const detail = `amp did not start the thread within ${this.timeouts.initMs / 1000} s${tail ? `: ${tail}` : ''}`;
      this.logger.error(detail, { sessionId: state.sessionId });
      this.terminateProcess(state, process);
      this.emit(state, { type: 'runtime.error', message: detail });
      state.awaitingTurns = [];
      if (state.turn) this.finishTurn(state, 'error', detail);
    }, this.timeouts.initMs);
    process.initTimer.unref();
  }

  /** Kills a run on purpose: its exit is not reported and the rest of its output is ignored. */
  private terminateProcess(state: AmpSessionState, process: AmpProcess): void {
    if (!process.alive) return;
    state.expectingExit = true;
    process.alive = false;
    stopProvider(process.child, 'SIGTERM');
    const kill = setTimeout(() => stopProvider(process.child, 'SIGKILL'), 2000);
    kill.unref();
    process.child.once('exit', () => clearTimeout(kill));
  }

  private async endProcess(process: AmpProcess): Promise<void> {
    if (!process.alive) return;
    await new Promise<void>((resolve) => {
      const term = setTimeout(() => stopProvider(process.child, 'SIGTERM'), 2000);
      const kill = setTimeout(() => stopProvider(process.child, 'SIGKILL'), 4000);
      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, 6000);
      const cleanup = () => {
        clearTimeout(term);
        clearTimeout(kill);
        clearTimeout(timeout);
        process.child.removeListener('exit', exited);
      };
      const exited = () => {
        cleanup();
        resolve();
      };
      process.child.once('exit', exited);
      // Amp stops once its input closes and the turn is over.
      process.child.stdin?.end();
    });
  }

  private stopProcessForInterrupt(state: AmpSessionState): void {
    const process = state.process;
    const turn = state.turn;
    if (process) this.terminateProcess(state, process);
    if (turn) this.finishTurn(state, 'interrupted', 'Interrupted.');
  }

  private write(state: AmpSessionState, message: Record<string, unknown>): void {
    const stdin = state.process?.child.stdin;
    if (!state.process?.alive || !stdin || !stdin.writable)
      throw new ProviderSessionError(PROVIDER, state.sessionId, 'amp is not running');
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async composeContent(
    state: AmpSessionState,
    input: ProviderSendTurnInput
  ): Promise<Array<Record<string, unknown> & { type: string }>> {
    const parts: string[] = [];
    if (state.pendingContext) parts.push(state.pendingContext);
    parts.push(input.text);
    const content: Array<Record<string, unknown> & { type: string }> = [];
    const mentions: string[] = [];
    for (const attachment of input.attachments ?? []) {
      if (IMAGE_TYPES.has(attachment.mimeType)) {
        const data = (await readFile(attachment.path)).toString('base64');
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: attachment.mimeType, data },
        });
      } else mentions.push(`Attached file: ${attachment.path} (${basename(attachment.path)})`);
    }
    if (mentions.length) parts.push(mentions.join('\n'));
    content.unshift({ type: 'text', text: parts.join('\n\n') });
    return content;
  }

  private handleLine(state: AmpSessionState, line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger.warn('amp emitted a line that is not JSON', { sessionId: state.sessionId, line });
      return;
    }
    if (!isRecord(message)) return;
    switch (message.type) {
      case 'system':
        this.handleSystem(state, message);
        return;
      case 'user':
        this.handleUser(state, message);
        return;
      case 'assistant':
        this.handleAssistant(state, message);
        return;
      case 'result':
        this.handleResult(state, message);
        return;
      default:
        return;
    }
  }

  private handleSystem(state: AmpSessionState, message: Record<string, unknown>): void {
    const process = state.process;
    switch (message.subtype) {
      case 'init': {
        const threadId = typeof message.session_id === 'string' ? message.session_id : '';
        if (state.threadId && threadId && threadId !== state.threadId) {
          const warning = `Amp continued thread ${threadId} instead of ${state.threadId}.`;
          this.logger.warn(warning, { sessionId: state.sessionId });
          this.emit(state, { type: 'runtime.warning', message: warning });
        }
        if (threadId) state.threadId = threadId;
        state.threadFresh = false;
        const agentMode = typeof message.agent_mode === 'string' ? message.agent_mode : '';
        if (agentMode && state.mode && agentMode !== state.mode) {
          const warning = `Amp runs this thread in ${agentMode} mode, not ${state.mode}.`;
          this.logger.warn(warning, { sessionId: state.sessionId });
          this.emit(state, { type: 'runtime.warning', message: warning });
        }
        if (agentMode) state.mode = agentMode;
        if (Array.isArray(message.subagents))
          for (const subagent of message.subagents)
            if (isRecord(subagent) && typeof subagent.tool_use_id === 'string')
              state.backgroundSubagents.add(subagent.tool_use_id);
        if (process && !process.initialized) {
          process.initialized = true;
          if (process.initTimer) clearTimeout(process.initTimer);
          process.initTimer = undefined;
        }
        return;
      }
      case 'subagent_finished': {
        const toolUseId = typeof message.tool_use_id === 'string' ? message.tool_use_id : '';
        state.backgroundSubagents.delete(toolUseId);
        const item = state.toolItems.get(toolUseId);
        if (item) {
          state.toolItems.delete(toolUseId);
          const status: ItemStatus = message.status === 'completed' ? 'completed' : 'failed';
          this.emit(state, {
            type: 'item.completed',
            turnId: state.turn?.turnId ?? '',
            item: { ...item, status },
            raw: { source: 'amp', payload: message },
          });
        }
        return;
      }
      case 'error_during_execution':
      case 'error_max_turns': {
        const error = typeof message.error === 'string' ? message.error : String(message.subtype);
        this.emit(state, {
          type: 'runtime.error',
          message: error,
          raw: { source: 'amp', payload: message },
        });
        if (state.turn) this.finishTurn(state, 'error', error);
        return;
      }
      default:
        return;
    }
  }

  private handleUser(state: AmpSessionState, message: Record<string, unknown>): void {
    const body = isRecord(message.message) ? message.message : {};
    const content = Array.isArray(body.content) ? body.content : [];
    const texts: string[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        this.completeToolItem(
          state,
          block.tool_use_id,
          block.is_error === true,
          block.content,
          block
        );
      } else if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
    if (texts.length > 0 && message.parent_tool_use_id === null)
      this.turnStarting(state, texts.join('\n'));
  }

  /**
   * Amp echoes a user message when it takes it up, and the plugin reports the
   * same in `agent.start`. A message sent mid-turn is found here by its text:
   * taken up by the running turn (Amp's next interruption point, a tool
   * boundary), it is reported as a turn that started and ended at once, its
   * reply arriving under the running one; taken up after that turn ended, it
   * runs as a turn of its own.
   */
  private turnStarting(state: AmpSessionState, text: string): void {
    const index = state.awaitingTurns.findIndex((entry) => entry.text === text);
    if (index < 0) return;
    const [entry] = state.awaitingTurns.splice(index, 1);
    if (state.turn) {
      if (state.turn.turnId === entry!.turnId) return;
      this.emit(state, { type: 'turn.started', turnId: entry!.turnId });
      this.emit(state, {
        type: 'turn.completed',
        turnId: entry!.turnId,
        outcome: 'completed',
        message: 'Amp took this message up in the turn already running; its reply arrives there.',
        usage: [],
      });
      return;
    }
    state.turn = { turnId: entry!.turnId };
    this.emit(state, { type: 'session.state.changed', status: 'running' });
    this.emit(state, { type: 'turn.started', turnId: entry!.turnId });
  }

  private handleAssistant(state: AmpSessionState, message: Record<string, unknown>): void {
    const body = isRecord(message.message) ? message.message : {};
    const topLevel = message.parent_tool_use_id === null;
    if (isRecord(body.usage)) this.recordUsage(state, body.usage, body.model, topLevel);
    const content = Array.isArray(body.content) ? body.content : [];
    const messageId = typeof body.id === 'string' ? body.id : randomUUID();
    const turnId = state.turn?.turnId;
    content.forEach((block, index) => {
      if (!isRecord(block)) return;
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        const toolInput = isRecord(block.input) ? block.input : {};
        const item: ProviderItem = {
          id: block.id,
          type: itemTypeForTool(block.name),
          status: 'in_progress',
          title: toolTitle(block.name, toolInput),
          toolName: block.name,
          payload: toolInput,
        };
        if (isBackgroundSubagentCall(block.name, toolInput))
          state.backgroundSubagents.add(block.id);
        state.toolItems.set(block.id, item);
        if (turnId !== undefined && topLevel)
          this.emit(state, {
            type: 'item.started',
            turnId,
            item,
            raw: { source: 'amp', payload: block },
          });
        return;
      }
      if (turnId === undefined || !topLevel) return;
      if (block.type === 'text' && typeof block.text === 'string') {
        const itemId = `${messageId}#${index}`;
        this.emit(state, {
          type: 'item.started',
          turnId,
          item: {
            id: itemId,
            type: 'assistant_message',
            status: 'in_progress',
            title: '',
            text: '',
          },
        });
        if (block.text)
          this.emit(state, { type: 'content.delta', turnId, itemId, delta: block.text });
        this.emit(state, {
          type: 'item.completed',
          turnId,
          item: {
            id: itemId,
            type: 'assistant_message',
            status: 'completed',
            title: truncate(block.text, 80),
            text: block.text,
          },
        });
        return;
      }
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        this.emit(state, {
          type: 'item.completed',
          turnId,
          item: {
            id: `${messageId}#t${index}`,
            type: 'reasoning',
            status: 'completed',
            title: truncate(block.thinking, 80),
            text: block.thinking,
          },
        });
      }
    });
    const stopReason = typeof body.stop_reason === 'string' ? body.stop_reason : null;
    if (topLevel && state.turn && stopReason && TURN_ENDING_STOP_REASONS.has(stopReason))
      this.modelStopped(state);
  }

  /**
   * The model has given its last message. With the plugin loaded, its
   * `agent.end` closes the turn and says how it ended; the turn closes anyway
   * after a grace period, so a plugin that falls silent cannot hang it.
   */
  private modelStopped(state: AmpSessionState): void {
    const turn = state.turn;
    if (!turn) return;
    if (!state.process?.pluginReady) {
      this.finishTurn(state, 'completed');
      return;
    }
    if (turn.endGrace) return;
    turn.endGrace = setTimeout(() => {
      if (state.turn !== turn) return;
      this.logger.warn('The Amp plugin did not report the end of the turn; closing it.', {
        sessionId: state.sessionId,
      });
      this.finishTurn(state, 'completed');
    }, this.timeouts.endGraceMs);
    turn.endGrace.unref();
  }

  private completeToolItem(
    state: AmpSessionState,
    toolUseId: string,
    isError: boolean,
    content: unknown,
    raw: unknown
  ): void {
    const item = state.toolItems.get(toolUseId);
    if (!item) return;
    state.toolItems.delete(toolUseId);
    state.backgroundSubagents.delete(toolUseId);
    const declined = state.declinedToolUses.delete(toolUseId);
    const status: ItemStatus = declined ? 'declined' : isError ? 'failed' : 'completed';
    const text = textFromToolResultContent(content);
    this.emit(state, {
      type: 'item.completed',
      turnId: state.turn?.turnId ?? '',
      item: { ...item, status, ...(text !== undefined ? { text } : {}) },
      raw: { source: 'amp', payload: raw },
    });
  }

  private handleResult(state: AmpSessionState, message: Record<string, unknown>): void {
    const isError = message.is_error === true;
    const error = typeof message.error === 'string' ? message.error : undefined;
    if (isError) {
      this.emit(state, {
        type: 'runtime.error',
        message: error ?? `Amp ended with ${String(message.subtype)}.`,
        raw: { source: 'amp', payload: message },
      });
    }
    if (state.turn) this.finishTurn(state, isError ? 'error' : 'completed', error);
  }

  private recordUsage(
    state: AmpSessionState,
    usage: Record<string, unknown>,
    model: unknown,
    topLevel: boolean
  ): void {
    const count = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
    const spent: TokenUsage = {
      model: typeof model === 'string' ? model : '',
      inputTokens: count('input_tokens'),
      outputTokens: count('output_tokens'),
      cacheReadTokens: count('cache_read_input_tokens'),
      cacheWriteTokens: count('cache_creation_input_tokens'),
    };
    state.unreportedUsage = mergeUsage(state.unreportedUsage, [spent]);
    if (topLevel)
      state.context = {
        usedTokens:
          spent.inputTokens + spent.cacheReadTokens + spent.cacheWriteTokens + spent.outputTokens,
        windowTokens: typeof usage.max_tokens === 'number' ? usage.max_tokens : null,
      };
  }

  private finishTurn(state: AmpSessionState, outcome: TurnOutcome, message?: string): void {
    const turn = state.turn;
    if (!turn) return;
    if (turn.endGrace) clearTimeout(turn.endGrace);
    if (turn.cancelTimer) clearTimeout(turn.cancelTimer);
    state.turn = null;
    if (outcome !== 'completed') {
      for (const [id, item] of [...state.toolItems]) {
        if (state.backgroundSubagents.has(id)) continue;
        state.toolItems.delete(id);
        this.emit(state, {
          type: 'item.completed',
          turnId: turn.turnId,
          item: {
            ...item,
            status: 'failed',
            text: [item.text, message].filter(Boolean).join('\n'),
          },
        });
      }
      this.cancelPending(state, message ?? 'The turn ended.');
    }
    this.emit(state, {
      type: 'turn.completed',
      turnId: turn.turnId,
      outcome,
      ...(message ? { message } : {}),
      usage: this.takeUsage(state),
    });
    this.emit(state, { type: 'session.state.changed', status: 'ready' });
  }

  private takeUsage(state: AmpSessionState): TokenUsage[] {
    const usage = state.unreportedUsage;
    state.unreportedUsage = [];
    return usage;
  }

  private pluginHandler(state: AmpSessionState): AmpPluginSessionHandler {
    return {
      ready: () => {
        const process = state.process;
        if (!process) return;
        process.pluginReady = true;
        for (const waiter of [...process.readyWaiters]) waiter.resolve();
        process.readyWaiters.clear();
      },
      sessionStart: () => {},
      agentStart: (_threadId, _messageId, message) => {
        if (message !== undefined) this.turnStarting(state, message);
      },
      agentEnd: (_threadId, _messageId, status) => {
        if (!state.turn) return;
        const outcome = outcomeOf(status);
        this.finishTurn(
          state,
          outcome,
          outcome === 'interrupted'
            ? 'Interrupted.'
            : outcome === 'error'
              ? 'Amp reported an error.'
              : undefined
        );
      },
      toolCall: (request) => this.decideToolCall(state, request),
      toolCallWait: (toolUseID) => {
        const pending = state.approvalsByToolUse.get(toolUseID);
        if (!pending)
          return Promise.resolve({
            status: 'reject',
            message: 'Switch no longer has this request.',
          });
        return this.awaitDecision(state, pending);
      },
      control: () => this.nextControl(state),
      cancelled: (_threadId, ok, error) => {
        if (ok) return;
        this.logger.warn('The Amp plugin could not cancel the turn; stopping the process.', {
          sessionId: state.sessionId,
          error,
        });
        this.stopProcessForInterrupt(state);
      },
    };
  }

  private decideToolCall(
    state: AmpSessionState,
    request: AmpToolCallRequest
  ): Promise<AmpToolDecision> {
    const policy = toolPolicy({
      runtimeMode: state.runtimeMode,
      tool: request.tool,
      toolInput: request.input,
      command: request.command,
      autoApprovedMcpServers: state.autoApprovedMcpServers,
      connectorMcpServers: state.connectorMcpServers,
    });
    if (policy.kind === 'allow') return Promise.resolve({ status: 'allow' });
    if (state.sessionAllowed.has(sessionKey(request))) return Promise.resolve({ status: 'allow' });
    const existing = state.approvalsByToolUse.get(request.toolUseID);
    if (existing) return this.awaitDecision(state, existing);
    const requestId = `amp-req-${++this.requestSeq}-${randomUUID().slice(0, 8)}`;
    const pending: PendingApproval = {
      requestId,
      toolUseID: request.toolUseID,
      sessionKey: sessionKey(request),
      decision: null,
      waiters: new Set(),
    };
    state.approvals.set(requestId, pending);
    state.approvalsByToolUse.set(request.toolUseID, pending);
    this.emit(state, {
      type: 'request.opened',
      turnId: state.turn?.turnId ?? '',
      requestId,
      requestType: policy.requestType,
      title: policy.title,
      ...(policy.detail ? { detail: policy.detail } : {}),
      options: approvalOptions(['accept', 'acceptForSession', 'decline', 'cancel']),
      ...(policy.connector ? { connector: policy.connector } : {}),
    });
    return this.awaitDecision(state, pending);
  }

  /**
   * The decision for a plugin request, or `pending` once the plugin has
   * waited long enough and should ask again. A decision made between two of
   * its requests is kept until the plugin collects it: the request is only
   * forgotten once Amp has been told.
   */
  private awaitDecision(
    state: AmpSessionState,
    pending: PendingApproval
  ): Promise<AmpToolDecision> {
    const collected = (decision: AmpToolDecision) => {
      if (
        decision.status !== 'pending' &&
        state.approvalsByToolUse.get(pending.toolUseID) === pending
      )
        state.approvalsByToolUse.delete(pending.toolUseID);
      return decision;
    };
    if (pending.decision) return Promise.resolve(collected(pending.decision));
    return new Promise<AmpToolDecision>((resolve) => {
      const timer = setTimeout(() => {
        pending.waiters.delete(waiter);
        resolve({ status: 'pending' });
      }, this.timeouts.decisionWaitMs);
      timer.unref();
      const waiter = (decision: AmpToolDecision) => {
        clearTimeout(timer);
        resolve(collected(decision));
      };
      pending.waiters.add(waiter);
    });
  }

  private settleApproval(
    state: AmpSessionState,
    pending: PendingApproval,
    decision: ApprovalDecision
  ): void {
    state.approvals.delete(pending.requestId);
    const allowed = decision === 'accept' || decision === 'acceptForSession';
    if (decision === 'acceptForSession') state.sessionAllowed.add(pending.sessionKey);
    if (!allowed) state.declinedToolUses.add(pending.toolUseID);
    pending.decision = allowed
      ? { status: 'allow' }
      : {
          status: 'reject',
          message:
            decision === 'cancel'
              ? 'The tool call was cancelled in Switch.'
              : 'The user declined this tool call in Switch. Do not retry it another way.',
        };
    for (const waiter of [...pending.waiters]) waiter(pending.decision);
    pending.waiters.clear();
    this.emit(state, { type: 'request.resolved', requestId: pending.requestId, decision });
  }

  private cancelPending(state: AmpSessionState, reason: string): void {
    for (const pending of [...state.approvals.values()]) {
      state.approvals.delete(pending.requestId);
      pending.decision = { status: 'reject', message: reason };
      for (const waiter of [...pending.waiters]) waiter(pending.decision);
      pending.waiters.clear();
      this.emit(state, {
        type: 'request.resolved',
        requestId: pending.requestId,
        decision: 'cancel',
      });
    }
  }

  private sendControl(state: AmpSessionState, command: AmpControlCommand): void {
    const waiter = state.controlWaiters.values().next().value;
    if (waiter) {
      state.controlWaiters.delete(waiter);
      waiter(command);
      return;
    }
    state.controlQueue.push(command);
  }

  private nextControl(state: AmpSessionState): Promise<AmpControlCommand> {
    const queued = state.controlQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<AmpControlCommand>((resolve) => {
      const timer = setTimeout(() => {
        state.controlWaiters.delete(waiter);
        resolve({ kind: 'none' });
      }, this.timeouts.controlWaitMs);
      timer.unref();
      const waiter = (command: AmpControlCommand) => {
        clearTimeout(timer);
        resolve(command);
      };
      state.controlWaiters.add(waiter);
    });
  }

  private handleExit(state: AmpSessionState, process: AmpProcess, reason: string): void {
    if (process.exited) return;
    process.exited = true;
    process.alive = false;
    const detail = process.stderrTail.trim() ? `${reason}: ${process.stderrTail.trim()}` : reason;
    if (process.initTimer) clearTimeout(process.initTimer);
    process.initTimer = undefined;
    for (const waiter of [...process.readyWaiters]) waiter.reject(new Error(detail));
    process.readyWaiters.clear();
    if (state.process !== process) return;
    if (state.expectingExit) {
      state.expectingExit = false;
      return;
    }
    this.logger.error('amp exited unexpectedly', { sessionId: state.sessionId, reason: detail });
    if (state.turn) this.finishTurn(state, 'error', detail);
    this.cancelPending(state, detail);
    this.finishSession(state, detail);
  }

  private finishSession(state: AmpSessionState, reason: string): void {
    if (state.exited) return;
    state.exited = true;
    this.sessions.delete(state.sessionId);
    this.bridge.unregister(state.token);
    for (const waiter of [...state.controlWaiters]) waiter({ kind: 'none' });
    state.controlWaiters.clear();
    if (state.turn) this.finishTurn(state, state.stopping ? 'interrupted' : 'error', reason);
    this.emit(state, { type: 'session.state.changed', status: 'stopped' });
    this.emit(state, { type: 'session.exited', reason });
  }

  private requireSession(sessionId: string): AmpSessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new ProviderSessionError(PROVIDER, sessionId, 'unknown or stopped session');
    return state;
  }

  private emit(state: AmpSessionState, event: EmittableEvent): void {
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
        this.logger.error('amp event listener threw', { error: String(cause) });
      }
    }
  }
}

function sessionKey(request: AmpToolCallRequest): string {
  return request.command !== null ? `command:${request.command}` : `tool:${request.tool}`;
}

export function createAmpAdapter(options: AmpAdapterOptions = {}): AmpAdapter {
  return new AmpAdapter(options);
}
