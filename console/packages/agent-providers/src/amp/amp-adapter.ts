import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelChoice } from '@switch-console/shared/session-v1';
import {
  ProviderSessionError,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type RuntimeMode,
} from '../adapter';
import type {
  ApprovalDecision,
  ItemType,
  ProviderItem,
  ProviderRuntimeEvent,
  RequestType,
  TokenUsage,
} from '../events';
import { mcpApprovalContent, toolInputDetail } from '../mcp-approval';
import { spawnProvider, stopProvider } from '../provider-process';
import { noopLogger, type ProviderLogger } from '../transport/stdio-json-rpc';
import {
  mcpConfig,
  permissionRules,
  readUserSettings,
  sessionSettings,
  SHELL_TOOLS,
  writeApprovalHelper,
} from './settings';
import { AMP_LOGIN_FLOW, AMP_SIGNED_OUT, runAmp } from './sign-in';

/**
 * Amp's modes, which choose the model, its effort, the system prompt and the
 * tools together. A thread keeps the mode of its first message, so the model
 * is chosen when a session starts and cannot change in it.
 */
export const AMP_MODES: readonly ModelChoice[] = [
  { id: 'low', label: 'Low (small, well-defined tasks)', options: {} },
  { id: 'medium', label: 'Medium (default for most work)', options: {} },
  { id: 'high', label: 'High (hard tasks, more reasoning)', options: {} },
  { id: 'ultra', label: 'Ultra (open-ended, cross-cutting work)', options: {} },
];

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const EDIT_TOOL_NAMES = new Set(['edit_file', 'create_file', 'apply_patch', 'undo_edit']);
const APPROVAL_POLL_MS = 150;
const KILL_GRACE_MS = 3_000;

export interface AmpAdapterOptions {
  binaryPath?: string;
  logger?: ProviderLogger;
}

interface PendingApproval {
  requestId: string;
  file: string;
  toolName: string;
}

interface RunningTurn {
  turnId: string;
  child: ChildProcess;
  /** The text sent as this turn's message; output before Amp echoes it is earlier work. */
  prompt: string;
  started: boolean;
  /** Messages steered into the turn that Amp has not started on yet. */
  pendingSteers: number;
  stdinClosed: boolean;
  interrupted: boolean;
  signedOut: boolean;
  items: Map<string, ProviderItem>;
  usage: TokenUsage;
  result?: { isError: boolean; message?: string; usage?: TokenUsage };
  stderr: string;
  stdoutBuffer: string;
  /** Settles once the turn's `turn.completed` is out. */
  finished: Promise<void>;
  markFinished: () => void;
}

interface State {
  id: string;
  threadId: string;
  cwd: string;
  env: Record<string, string>;
  runtimeMode: RuntimeMode;
  mode?: string;
  /** Whether the thread already had its first message, which fixes its mode. */
  threadStarted: boolean;
  systemContext?: string;
  sessionDir: string;
  settingsPath: string;
  approvalsDir: string;
  mcpConfig?: string;
  hasSwitchMcp: boolean;
  connectors: Set<string>;
  turn: RunningTurn | null;
  /** A turn's process is being started; set until it is `turn`. */
  launching: boolean;
  queue: ProviderSendTurnInput[];
  approvals: Map<string, PendingApproval>;
  /** Helper requests already seen, by file stem. */
  seenRequests: Set<string>;
  allowedForSession: Set<string>;
  poller?: ReturnType<typeof setInterval>;
  stopping: boolean;
}

type Emittable<T = ProviderRuntimeEvent> = T extends ProviderRuntimeEvent
  ? Omit<T, 'eventId' | 'provider' | 'sessionId' | 'createdAt'>
  : never;

/**
 * Amp (ampcode.com) over its execute mode: one `amp threads continue <thread>
 * --execute --stream-json --stream-json-input` process per turn, reading
 * Claude Code-compatible stream JSON. A message sent mid-turn is written to the
 * same stdin with `steer: true`; stdin is closed once the agent ends its turn
 * with nothing steered still pending, and the `result` line that follows ends
 * the turn. Interrupting stops the process; the thread lives on ampcode.com, so
 * the next turn and a restarted session continue it by id. Approvals go
 * through a `delegate` permission rule (see `settings.ts`).
 */
export class AmpAdapter implements ProviderAdapter {
  readonly provider = 'amp';
  readonly capabilities: ProviderCapabilities = {
    modelSwitchInSession: false,
    steering: true,
    resume: true,
    approvals: true,
    userInput: false,
  };
  private readonly sessions = new Map<string, State>();
  private readonly listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly logger: ProviderLogger;
  private readonly binaryPath: string;

  constructor(options: AmpAdapterOptions = {}) {
    this.binaryPath = options.binaryPath ?? 'amp';
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
      throw new ProviderSessionError(this.provider, input.sessionId, 'session already started');
    const sessionDir = await mkdtemp(join(tmpdir(), 'switch-amp-'));
    try {
      const { helperPath, approvalsDir } = await writeApprovalHelper(sessionDir);
      const user = await readUserSettings(input.env);
      const connectors = new Set(input.connectorMcpServers);
      const rules = permissionRules({
        runtimeMode: input.runtimeMode,
        autoApprovedMcpServers: Object.keys(input.mcpServers).filter(
          (name) => !connectors.has(name)
        ),
        helperPath,
      });
      const settingsPath = join(sessionDir, 'settings.json');
      await writeFile(
        settingsPath,
        JSON.stringify(
          sessionSettings(user.settings, { runtimeMode: input.runtimeMode, rules }),
          null,
          2
        ),
        'utf8'
      );
      const mode = input.model?.id;
      const threadId =
        input.resume?.nativeSessionId ?? (await this.newThread(input, settingsPath, mode));
      const state: State = {
        id: input.sessionId,
        threadId,
        cwd: input.cwd,
        env: input.env,
        runtimeMode: input.runtimeMode,
        ...(mode ? { mode } : {}),
        threadStarted: Boolean(input.resume),
        ...(input.systemContext ? { systemContext: input.systemContext } : {}),
        sessionDir,
        settingsPath,
        approvalsDir,
        ...(Object.keys(input.mcpServers).length
          ? { mcpConfig: JSON.stringify(mcpConfig(input.mcpServers, input.env)) }
          : {}),
        hasSwitchMcp: Object.hasOwn(input.mcpServers, 'switch'),
        connectors,
        turn: null,
        launching: false,
        queue: [],
        approvals: new Map(),
        seenRequests: new Set(),
        allowedForSession: new Set(),
        stopping: false,
      };
      this.sessions.set(state.id, state);
      this.emit(state, { type: 'session.state.changed', status: 'starting' });
      if (user.warning) {
        this.logger.warn(user.warning);
        this.emit(state, { type: 'runtime.warning', message: user.warning });
      }
      this.emit(state, { type: 'session.started', nativeSessionId: threadId });
      this.emit(state, { type: 'session.state.changed', status: 'ready' });
      return { sessionId: state.id, nativeSessionId: threadId, provider: this.provider };
    } catch (error) {
      await rm(sessionDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Creates the session's thread on ampcode.com, without signing in. */
  private async newThread(
    input: ProviderSessionStartInput,
    settingsPath: string,
    mode: string | undefined
  ): Promise<string> {
    const result = await runAmp(
      this.binaryPath,
      ['threads', 'new', '--settings-file', settingsPath, ...(mode ? ['--mode', mode] : [])],
      { cwd: input.cwd, env: input.env, timeoutMs: 60_000 }
    ).catch((cause: unknown) => {
      throw new ProviderSessionError(
        this.provider,
        input.sessionId,
        `Could not run amp: ${String(cause)}`,
        {
          cause,
        }
      );
    });
    if (result.signedOut)
      throw new ProviderSessionError(this.provider, input.sessionId, AMP_SIGNED_OUT);
    const threadId = /\bT-[0-9a-f][0-9a-f-]+/i.exec(result.stdout)?.[0];
    if (result.code !== 0 || !threadId)
      throw new ProviderSessionError(
        this.provider,
        input.sessionId,
        `Could not start an Amp thread${result.timedOut ? ' within a minute' : ''}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`
      );
    return threadId;
  }

  async sendTurn(input: ProviderSendTurnInput) {
    const state = this.require(input.sessionId);
    const running = state.turn;
    if (running && !running.stdinClosed && running.child.stdin?.writable) {
      const message = await this.userMessage(state, input, true);
      if (state.turn === running && !running.stdinClosed) {
        running.pendingSteers += 1;
        running.child.stdin.write(message.line);
        return { turnId: input.turnId, steeredInto: running.turnId };
      }
    }
    state.queue.push(input);
    await this.drain(state);
    return { turnId: input.turnId };
  }

  private async drain(state: State): Promise<void> {
    if (state.turn || state.launching || state.stopping || !this.hasSession(state.id)) return;
    const input = state.queue.shift();
    if (!input) return;
    state.launching = true;
    let message: { line: string; text: string };
    try {
      message = await this.userMessage(state, input, false);
    } catch (cause) {
      state.launching = false;
      this.emit(state, { type: 'turn.started', turnId: input.turnId });
      this.emit(state, {
        type: 'turn.completed',
        turnId: input.turnId,
        outcome: 'error',
        message: `Could not send the message to Amp: ${String(cause)}`,
        usage: [],
      });
      return this.drain(state);
    }
    state.launching = false;
    if (state.stopping) {
      this.emit(state, {
        type: 'turn.completed',
        turnId: input.turnId,
        outcome: 'interrupted',
        message: 'Session stopped.',
        usage: [],
      });
      return;
    }
    const args = [
      'threads',
      'continue',
      state.threadId,
      '--execute',
      '--stream-json',
      '--stream-json-input',
      '--settings-file',
      state.settingsPath,
      '--no-ide',
      '--no-color',
      ...(state.mcpConfig ? ['--mcp-config', state.mcpConfig] : []),
      ...(!state.threadStarted && state.mode ? ['--mode', state.mode] : []),
    ];
    const child = spawnProvider(this.binaryPath, args, {
      cwd: state.cwd,
      env: state.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let markFinished = () => {};
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });
    const turn: RunningTurn = {
      finished,
      markFinished,
      turnId: input.turnId,
      child,
      prompt: message.text,
      started: false,
      pendingSteers: 0,
      stdinClosed: false,
      interrupted: false,
      signedOut: false,
      items: new Map(),
      usage: emptyUsage(),
      stderr: '',
      stdoutBuffer: '',
    };
    state.turn = turn;
    this.emit(state, { type: 'turn.started', turnId: turn.turnId });
    this.emit(state, { type: 'session.state.changed', status: 'running' });
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(state, turn, chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      turn.stderr = (turn.stderr + text).slice(-4000);
      if (AMP_LOGIN_FLOW.test(text)) this.signedOut(turn);
    });
    child.stdin?.on('error', (error) =>
      this.logger.warn('amp stdin closed early', { error: String(error) })
    );
    child.once('error', (error) => {
      turn.stderr += `\n${String(error)}`;
    });
    child.once('close', () => void this.finish(state, turn));
    child.stdin?.write(message.line);
    state.poller ??= setInterval(() => void this.pollApprovals(state), APPROVAL_POLL_MS);
  }

  private async userMessage(state: State, input: ProviderSendTurnInput, steer: boolean) {
    let text = input.text;
    if (state.systemContext) {
      text = `${state.systemContext}\n\n${text}`;
      delete state.systemContext;
    }
    const content: Array<Record<string, unknown>> = [];
    const unattached: string[] = [];
    for (const attachment of input.attachments ?? []) {
      if (!IMAGE_TYPES.has(attachment.mimeType)) {
        unattached.push(attachment.path);
        continue;
      }
      const data = (await readFile(attachment.path)).toString('base64');
      content.push({
        type: 'image',
        source_path: `file://${attachment.path}`,
        source: { type: 'base64', media_type: attachment.mimeType, data },
      });
    }
    if (unattached.length)
      text += `\n\nAttached files:\n${unattached.map((path) => `- ${path}`).join('\n')}`;
    const payload = {
      type: 'user',
      ...(steer ? { steer: true } : {}),
      message: { role: 'user', content: [{ type: 'text', text }, ...content] },
    };
    return { line: `${JSON.stringify(payload)}\n`, text };
  }

  private onStdout(state: State, turn: RunningTurn, chunk: string): void {
    turn.stdoutBuffer += chunk;
    let newline = turn.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = turn.stdoutBuffer.slice(0, newline).trim();
      turn.stdoutBuffer = turn.stdoutBuffer.slice(newline + 1);
      newline = turn.stdoutBuffer.indexOf('\n');
      if (!line) continue;
      let message: AmpStreamMessage;
      try {
        message = JSON.parse(line) as AmpStreamMessage;
      } catch {
        if (AMP_LOGIN_FLOW.test(line)) this.signedOut(turn);
        else
          this.logger.debug('amp printed a line that is not stream JSON', {
            line: line.slice(0, 500),
          });
        continue;
      }
      this.onMessage(state, turn, message);
    }
  }

  private onMessage(state: State, turn: RunningTurn, message: AmpStreamMessage): void {
    if (state.turn !== turn) return;
    if (message.type === 'result') {
      turn.result = {
        isError: Boolean(message.is_error),
        ...(message.is_error
          ? { message: message.error ?? message.result ?? 'Amp reported an error.' }
          : {}),
        ...(message.usage ? { usage: usageOf(message.usage) } : {}),
      };
      if (message.permission_denials?.length)
        this.emit(state, {
          type: 'runtime.warning',
          message: `Amp was refused ${message.permission_denials.join(', ')}.`,
        });
      return;
    }
    if (message.type === 'system') {
      if (message.subtype === 'init' && state.hasSwitchMcp && switchMcpFailed(message.mcp_servers))
        this.emit(state, {
          type: 'runtime.warning',
          message:
            'Amp could not connect to the Switch tools. Room replies and other Switch actions may be unavailable.',
        });
      if (message.subtype === 'error_during_execution' || message.subtype === 'error_max_turns')
        turn.result = { isError: true, message: message.error ?? message.subtype };
      return;
    }
    // Sub-agent internals stay inside the Task item that started them.
    if (message.parent_tool_use_id) return;
    const content = message.message?.content ?? [];
    if (message.type === 'user') {
      for (const block of content) {
        if (block.type === 'text') {
          if (!turn.started) {
            if (block.text?.trim() === turn.prompt.trim()) {
              turn.started = true;
              state.threadStarted = true;
            }
          } else if (turn.pendingSteers > 0) turn.pendingSteers -= 1;
        } else if (block.type === 'tool_result' && turn.started) {
          this.completeTool(state, turn, block);
        }
      }
      return;
    }
    if (message.type !== 'assistant' || !turn.started) return;
    if (message.message?.usage) addUsage(turn.usage, usageOf(message.message.usage));
    for (const block of content) {
      if (block.type === 'text' && block.text) this.assistantText(state, turn, block.text);
      else if ((block.type === 'thinking' && block.thinking) || block.type === 'redacted_thinking')
        this.reasoning(state, turn, block.thinking ?? '');
      else if (block.type === 'tool_use' && block.id) this.startTool(state, turn, block);
    }
    const stop = message.message?.stop_reason;
    if (stop && stop !== 'tool_use' && stop !== 'pause_turn' && turn.pendingSteers === 0)
      this.closeInput(turn);
  }

  private assistantText(state: State, turn: RunningTurn, text: string): void {
    const item: ProviderItem = {
      id: randomUUID(),
      type: 'assistant_message',
      status: 'in_progress',
      title: 'Amp',
    };
    this.emit(state, { type: 'item.started', turnId: turn.turnId, item });
    this.emit(state, { type: 'content.delta', turnId: turn.turnId, itemId: item.id, delta: text });
    this.emit(state, {
      type: 'item.completed',
      turnId: turn.turnId,
      item: { ...item, status: 'completed', text },
    });
  }

  private reasoning(state: State, turn: RunningTurn, text: string): void {
    const item: ProviderItem = {
      id: randomUUID(),
      type: 'reasoning',
      status: 'completed',
      title: 'Thinking',
      text,
    };
    this.emit(state, {
      type: 'item.started',
      turnId: turn.turnId,
      item: { ...item, status: 'in_progress' },
    });
    this.emit(state, { type: 'item.completed', turnId: turn.turnId, item });
  }

  private startTool(state: State, turn: RunningTurn, block: AmpContentBlock): void {
    const name = block.name ?? 'tool';
    const input = block.input ?? {};
    const item: ProviderItem = {
      id: block.id!,
      type: toolItemType(name),
      status: 'in_progress',
      title: toolTitle(name, input),
      toolName: name,
      payload: { input },
    };
    turn.items.set(item.id, item);
    this.emit(state, { type: 'item.started', turnId: turn.turnId, item });
  }

  private completeTool(state: State, turn: RunningTurn, block: AmpContentBlock): void {
    const item = block.tool_use_id ? turn.items.get(block.tool_use_id) : undefined;
    if (!item) return;
    turn.items.delete(item.id);
    const text =
      typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
    this.emit(state, {
      type: 'item.completed',
      turnId: turn.turnId,
      item: { ...item, status: block.is_error ? 'failed' : 'completed', text },
    });
  }

  /** No more input: Amp finishes what it has (background subagents too), prints `result` and exits. */
  private closeInput(turn: RunningTurn): void {
    if (turn.stdinClosed) return;
    turn.stdinClosed = true;
    turn.child.stdin?.end();
  }

  private signedOut(turn: RunningTurn): void {
    if (turn.signedOut) return;
    turn.signedOut = true;
    this.kill(turn);
  }

  private kill(turn: RunningTurn): void {
    this.closeInput(turn);
    stopProvider(turn.child, 'SIGINT');
    const timer = setTimeout(() => stopProvider(turn.child, 'SIGKILL'), KILL_GRACE_MS);
    turn.child.once('close', () => clearTimeout(timer));
  }

  private async finish(state: State, turn: RunningTurn): Promise<void> {
    if (state.turn !== turn) return;
    if (turn.stdoutBuffer.trim()) this.onStdout(state, turn, '\n');
    let outcome: 'completed' | 'interrupted' | 'error';
    let message: string | undefined;
    if (turn.interrupted) {
      outcome = 'interrupted';
      message = 'Interrupted.';
    } else if (turn.signedOut) {
      outcome = 'error';
      message = AMP_SIGNED_OUT;
    } else if (!turn.result) {
      outcome = 'error';
      const said = turn.stderr.trim().split('\n').slice(-5).join('\n');
      message = `Amp exited without finishing the turn${said ? `: ${said}` : '.'}`;
    } else if (turn.result.isError) {
      outcome = 'error';
      message = turn.result.message;
    } else outcome = 'completed';
    for (const item of turn.items.values())
      this.emit(state, {
        type: 'item.completed',
        turnId: turn.turnId,
        item: { ...item, status: 'failed', ...(message ? { text: message } : {}) },
      });
    turn.items.clear();
    await this.cancelApprovals(state);
    state.turn = null;
    const usage = turn.result?.usage ?? turn.usage;
    this.emit(state, {
      type: 'turn.completed',
      turnId: turn.turnId,
      outcome,
      ...(message ? { message } : {}),
      usage: hasUsage(usage) ? [usage] : [],
    });
    turn.markFinished();
    if (!state.stopping) {
      this.emit(state, { type: 'session.state.changed', status: 'ready' });
      await this.drain(state);
    }
    if (!state.turn && state.poller) {
      clearInterval(state.poller);
      delete state.poller;
    }
  }

  async interruptTurn(sessionId: string): Promise<void> {
    const state = this.require(sessionId);
    const turn = state.turn;
    if (!turn) return;
    turn.interrupted = true;
    await this.cancelApprovals(state);
    this.kill(turn);
  }

  private async pollApprovals(state: State): Promise<void> {
    let names: string[];
    try {
      names = await readdir(state.approvalsDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.request')) continue;
      const stem = name.slice(0, -'.request'.length);
      if (state.seenRequests.has(stem)) continue;
      state.seenRequests.add(stem);
      const file = join(state.approvalsDir, stem);
      const [toolLines, inputText] = await Promise.all([
        readFile(`${file}.tool`, 'utf8').catch(() => ''),
        readFile(`${file}.input`, 'utf8').catch(() => ''),
      ]);
      const toolName = toolLines.split('\n')[0]?.trim() || 'tool';
      let input: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(inputText);
        if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
      } catch {
        // The card shows no detail rather than a guess.
      }
      this.openApproval(state, { file, toolName, input });
    }
  }

  private openApproval(
    state: State,
    request: { file: string; toolName: string; input: Record<string, unknown> }
  ): void {
    const turn = state.turn;
    if (!turn || state.stopping) {
      void answer(request.file, 'deny', 'No turn is running in Switch.');
      return;
    }
    if (state.allowedForSession.has(request.toolName)) {
      void answer(request.file, 'allow');
      return;
    }
    const requestId = randomUUID();
    state.approvals.set(requestId, { requestId, file: request.file, toolName: request.toolName });
    const content = approvalContent(request.toolName, request.input);
    const server = mcpServerOf(request.toolName);
    this.emit(state, {
      type: 'request.opened',
      turnId: turn.turnId,
      requestId,
      requestType: content.requestType,
      title: content.title,
      ...(content.detail ? { detail: content.detail } : {}),
      options: [
        { decision: 'accept', label: 'Allow once' },
        { decision: 'acceptForSession', label: `Allow ${request.toolName} for this session` },
        { decision: 'decline', label: 'Reject' },
      ],
      ...(server && state.connectors.has(server) ? { connector: server } : {}),
    });
  }

  async respondToRequest(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    const state = this.require(sessionId);
    const pending = state.approvals.get(requestId);
    if (!pending)
      throw new ProviderSessionError(
        this.provider,
        sessionId,
        `Unknown or answered request: ${requestId}`
      );
    state.approvals.delete(requestId);
    if (decision === 'acceptForSession') state.allowedForSession.add(pending.toolName);
    const allowed = decision === 'accept' || decision === 'acceptForSession';
    await answer(
      pending.file,
      allowed ? 'allow' : 'deny',
      'The person using Switch declined this tool call.'
    );
    this.emit(state, { type: 'request.resolved', requestId, decision });
  }

  async respondToUserInput(sessionId: string): Promise<void> {
    throw new ProviderSessionError(
      this.provider,
      sessionId,
      'Amp does not ask questions through Switch.'
    );
  }

  private async cancelApprovals(state: State): Promise<void> {
    for (const pending of [...state.approvals.values()]) {
      state.approvals.delete(pending.requestId);
      await answer(pending.file, 'deny', 'The turn was stopped.');
      this.emit(state, {
        type: 'request.resolved',
        requestId: pending.requestId,
        decision: 'cancel',
      });
    }
  }

  async listModels(sessionId: string): Promise<ModelChoice[]> {
    this.require(sessionId);
    return [...AMP_MODES];
  }

  async stopSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.stopping = true;
    const turn = state.turn;
    if (turn) {
      turn.interrupted = true;
      await this.cancelApprovals(state);
      this.kill(turn);
      await turn.finished;
    }
    for (const input of state.queue.splice(0))
      this.emit(state, {
        type: 'turn.completed',
        turnId: input.turnId,
        outcome: 'interrupted',
        message: 'Session stopped.',
        usage: [],
      });
    if (state.poller) clearInterval(state.poller);
    this.sessions.delete(sessionId);
    await rm(state.sessionDir, { recursive: true, force: true });
    this.emit(state, { type: 'session.state.changed', status: 'stopped' });
    this.emit(state, { type: 'session.exited', reason: 'Session stopped' });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stopSession(id)));
  }

  private require(id: string): State {
    const state = this.sessions.get(id);
    if (!state || state.stopping)
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
        this.logger.error('Amp event listener failed', { error: String(cause) });
      }
    }
  }
}

export function createAmpAdapter(options: AmpAdapterOptions = {}): AmpAdapter {
  return new AmpAdapter(options);
}

/** Answers the approval helper waiting on `file`; the deny reason goes back to the model. */
async function answer(file: string, verdict: 'allow' | 'deny', reason = ''): Promise<void> {
  try {
    await writeFile(`${file}.answer`, verdict === 'deny' ? `${reason}\n` : '', 'utf8');
    await rename(`${file}.answer`, `${file}.${verdict}`);
  } catch {
    // The helper is gone: its Amp process ended, which denies the call anyway.
  }
}

interface AmpContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface AmpUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AmpStreamMessage {
  type: 'system' | 'user' | 'assistant' | 'result';
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: AmpContentBlock[]; stop_reason?: string | null; usage?: AmpUsage };
  is_error?: boolean;
  result?: string;
  error?: string;
  usage?: AmpUsage;
  permission_denials?: string[];
  mcp_servers?: unknown;
}

function switchMcpFailed(servers: unknown): boolean {
  if (!Array.isArray(servers)) return false;
  return servers.some((server: unknown) => {
    if (typeof server !== 'object' || server === null) return false;
    const entry = server as Record<string, unknown>;
    return (
      entry.name === 'switch' &&
      (entry.status === 'failed' ||
        entry.status === 'denied' ||
        entry.status === 'blocked-by-registry')
    );
  });
}

function emptyUsage(): TokenUsage {
  return { model: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function usageOf(usage: AmpUsage): TokenUsage {
  return {
    model: '',
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(into: TokenUsage, more: TokenUsage): void {
  into.inputTokens += more.inputTokens;
  into.outputTokens += more.outputTokens;
  into.cacheReadTokens += more.cacheReadTokens;
  into.cacheWriteTokens += more.cacheWriteTokens;
}

function hasUsage(usage: TokenUsage): boolean {
  return (
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0
  );
}

function mcpServerOf(toolName: string): string | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match?.[1];
}

export function toolItemType(name: string): ItemType {
  if (SHELL_TOOLS.has(name)) return 'command_execution';
  if (EDIT_TOOL_NAMES.has(name)) return 'file_change';
  if (name === 'Task') return 'subagent';
  if (name === 'web_search') return 'web_search';
  if (name.startsWith('mcp__')) return 'mcp_tool_call';
  return 'tool_call';
}

function commandOf(input: Record<string, unknown>): string | undefined {
  const command = input.cmd ?? input.command;
  return typeof command === 'string' ? command : undefined;
}

function pathOf(input: Record<string, unknown>): string | undefined {
  const path = input.path ?? input.file_path;
  return typeof path === 'string' ? path : undefined;
}

function toolTitle(name: string, input: Record<string, unknown>): string {
  if (SHELL_TOOLS.has(name)) return commandOf(input) ?? name;
  if (EDIT_TOOL_NAMES.has(name)) return pathOf(input) ?? name;
  if (name === 'Task' && typeof input.description === 'string') return input.description;
  return name;
}

export function approvalContent(
  toolName: string,
  input: Record<string, unknown>
): { requestType: RequestType; title: string; detail?: string } {
  if (SHELL_TOOLS.has(toolName)) {
    const detail = commandOf(input);
    return {
      requestType: 'command_execution_approval',
      title: 'Amp wants to run a command',
      ...(detail ? { detail } : {}),
    };
  }
  if (EDIT_TOOL_NAMES.has(toolName)) {
    const detail = pathOf(input);
    return {
      requestType: 'file_change_approval',
      title: 'Amp wants to change a file',
      ...(detail ? { detail } : {}),
    };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp)
    return { requestType: 'mcp_tool_approval', ...mcpApprovalContent(mcp[1]!, mcp[2]!, input) };
  const detail = toolInputDetail(input);
  return {
    requestType: 'tool_approval',
    title: `Amp wants to use ${toolName}`,
    ...(detail ? { detail } : {}),
  };
}
