import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  type ModelSelection,
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
  ItemType,
  ProviderItem,
  ProviderRuntimeEvent,
  RequestType,
  SessionStatus,
  TurnOutcome,
  UserInputAnswers,
  UserInputQuestion,
} from '../events';
import { buildConfigFile, parseModelId, permissionRulesFor } from './config';
import type { OpencodeSkill } from './server';
import {
  createHttpTransport,
  type OpencodeEvent,
  type OpencodePermissionReply,
  type OpencodeSessionTransport,
  type OpencodeTransport,
} from './transport';

export interface OpencodeLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface OpencodeAdapterOptions {
  /** Defaults to `opencode` on `PATH`. */
  binaryPath?: string;
  logger?: OpencodeLogger;
  startupTimeoutMs?: number;
  /**
   * How long to wait for OpenCode to report `busy` after a prompt before
   * falling back to polling `session.status`.
   */
  admissionTimeoutMs?: number;
  /**
   * Skills to place in every session's isolated config home.
   *
   * The transport isolates `XDG_CONFIG_HOME` to keep the user's own MCP
   * registrations out of a session, which hides their `skills/` directory with
   * them. Anything the session must be able to load — the Switch room-workflow
   * skill, for one — has to be supplied here or it is simply not there.
   */
  skills?: OpencodeSkill[];
  /** Replaces the spawned server; the unit tests drive the adapter through this. */
  transport?: OpencodeTransport;
}

/** The variant-specific half of an event; the envelope is filled in by `emit`. */
type ProviderEventBody = ProviderRuntimeEvent extends infer Event
  ? Event extends ProviderRuntimeEvent
    ? Omit<Event, 'createdAt' | 'eventId' | 'provider' | 'raw' | 'sessionId' | 'turnId'>
    : never
  : never;

const NOOP_LOGGER: OpencodeLogger = { debug: () => {}, warn: () => {}, error: () => {} };

const APPROVAL_OPTIONS: ApprovalOption[] = [
  { decision: 'accept', label: 'Allow once' },
  { decision: 'acceptForSession', label: 'Allow for the rest of this session' },
  { decision: 'decline', label: 'Deny' },
];

interface SessionRecord {
  sessionId: string;
  nativeSessionId: string;
  cwd: string;
  runtimeMode: RuntimeMode;
  model?: { providerID: string; modelID: string };
  systemContext?: string;
  mcpNames: string[];
  transport: OpencodeSessionTransport;
  stopping: boolean;
  exited: boolean;
  activeTurnId?: string;
  /** An `idle` is only honored once OpenCode has confirmed the prompt with a `busy`. */
  awaitingBusy: boolean;
  admissionTimer?: ReturnType<typeof setTimeout>;
  suppressAbortError: boolean;
  messageRoles: Map<string, string>;
  partTypes: Map<string, string>;
  emittedText: Map<string, string>;
  items: Map<string, ProviderItem>;
  pendingApprovals: Map<string, { turnId: string }>;
  pendingQuestions: Map<string, { turnId: string }>;
}

export class OpencodeAdapter implements ProviderAdapter {
  readonly provider = 'opencode' as const;
  readonly capabilities: ProviderCapabilities = {
    modelSwitchInSession: true,
    steering: true,
    resume: true,
    approvals: true,
    userInput: true,
  };

  private readonly sessions = new Map<string, SessionRecord>();
  private readonly listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly transport: OpencodeTransport;
  private readonly logger: OpencodeLogger;
  private readonly admissionTimeoutMs: number;

  constructor(options: OpencodeAdapterOptions = {}) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.admissionTimeoutMs = options.admissionTimeoutMs ?? 30_000;
    this.transport =
      options.transport ??
      createHttpTransport({
        binaryPath: options.binaryPath ?? 'opencode',
        startupTimeoutMs: options.startupTimeoutMs ?? 60_000,
        skills: options.skills ?? [],
      });
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

  async startSession(input: ProviderSessionStartInput): Promise<ProviderSession> {
    if (this.sessions.has(input.sessionId)) {
      throw new ProviderSessionError('opencode', input.sessionId, 'session already started');
    }
    const model = input.model ? parseModelId(input.model.id) : undefined;
    this.publish({
      type: 'session.state.changed',
      provider: 'opencode',
      sessionId: input.sessionId,
      status: 'starting',
      eventId: randomUUID(),
      createdAt: new Date().toISOString(),
    });

    const transport = await this.transport.open({
      sessionId: input.sessionId,
      cwd: input.cwd,
      env: input.env,
      config: buildConfigFile(input.runtimeMode, input.mcpServers),
      permission: permissionRulesFor(input.runtimeMode),
      ...(input.resume ? { resumeNativeSessionId: input.resume.nativeSessionId } : {}),
      ...(model ? { model } : {}),
    });

    const record: SessionRecord = {
      sessionId: input.sessionId,
      nativeSessionId: transport.nativeSessionId,
      cwd: input.cwd,
      runtimeMode: input.runtimeMode,
      ...(model ? { model } : {}),
      ...(input.systemContext ? { systemContext: input.systemContext } : {}),
      mcpNames: Object.keys(input.mcpServers),
      transport,
      stopping: false,
      exited: false,
      awaitingBusy: false,
      suppressAbortError: false,
      messageRoles: new Map(),
      partTypes: new Map(),
      emittedText: new Map(),
      items: new Map(),
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
    };
    this.sessions.set(input.sessionId, record);

    transport.onExit((reason) => {
      this.handleUnexpectedExit(record, reason);
    });
    void this.pump(record);

    this.emit(record, { type: 'session.started', nativeSessionId: transport.nativeSessionId });
    this.emitState(record, 'ready');
    return {
      sessionId: input.sessionId,
      nativeSessionId: transport.nativeSessionId,
      provider: 'opencode',
    };
  }

  /**
   * OpenCode has no separate steer endpoint. A `prompt_async` sent while the
   * session is busy answers 204 and is queued into the running agent loop:
   * measured against opencode 1.18.27, the running message finishes, the queued
   * one is answered as the next message, and the session reports one unbroken
   * `busy` span across both, ending in a single `idle`. There is no second
   * busy/idle pair to hang a second turn on, so the queued message is reported
   * against the running turn and that turn completes exactly once.
   *
   * `awaitingBusy` is raised across every submission, steers included: an
   * `idle` that OpenCode had already queued before the prompt was admitted must
   * not be read as the turn finishing.
   */
  async sendTurn(input: ProviderSendTurnInput): Promise<ProviderTurnStartResult> {
    const record = this.require(input.sessionId);
    const model = input.model ? parseModelId(input.model.id) : record.model;
    const steeredInto = record.activeTurnId;
    const turnId = steeredInto ?? input.turnId;
    const previousAwaitingBusy = record.awaitingBusy;

    if (steeredInto === undefined) {
      record.activeTurnId = input.turnId;
      this.emit(record, { type: 'turn.started' }, input.turnId);
    }
    record.awaitingBusy = true;

    try {
      await record.transport.prompt({
        text: input.text,
        ...(record.systemContext ? { system: record.systemContext } : {}),
        ...(model ? { model } : {}),
        ...(input.attachments && input.attachments.length > 0
          ? {
              files: input.attachments.map((attachment) => ({
                url: pathToFileURL(attachment.path).href,
                mime: attachment.mimeType,
                filename: attachment.path.split('/').pop() ?? attachment.path,
              })),
            }
          : {}),
      });
    } catch (error) {
      if (steeredInto === undefined) {
        this.completeTurn(record, turnId, 'error', errorMessage(error));
      } else {
        record.awaitingBusy = previousAwaitingBusy;
      }
      throw new ProviderSessionError('opencode', input.sessionId, 'prompt was rejected', {
        cause: error,
      });
    }

    this.armAdmissionTimer(record, turnId);
    return steeredInto === undefined ? { turnId } : { turnId: input.turnId, steeredInto };
  }

  async interruptTurn(sessionId: string): Promise<void> {
    const record = this.require(sessionId);
    const turnId = record.activeTurnId;
    if (turnId === undefined) return;
    record.suppressAbortError = true;
    try {
      await record.transport.abort();
    } catch (error) {
      this.logger.warn('opencode: session.abort failed', { sessionId, error: errorMessage(error) });
      this.emit(record, {
        type: 'runtime.warning',
        message: `could not abort the OpenCode session: ${errorMessage(error)}`,
      });
    }
    this.completeTurn(record, turnId, 'interrupted');
  }

  async respondToRequest(
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    const record = this.require(sessionId);
    if (!record.pendingApprovals.has(requestId)) {
      throw new ProviderSessionError(
        'opencode',
        sessionId,
        `no pending approval with id '${requestId}'`
      );
    }
    await record.transport.replyPermission(requestId, toPermissionReply(decision));
  }

  async respondToUserInput(
    sessionId: string,
    requestId: string,
    answers: UserInputAnswers
  ): Promise<void> {
    const record = this.require(sessionId);
    const pending = record.pendingQuestions.get(requestId);
    if (pending === undefined) {
      throw new ProviderSessionError(
        'opencode',
        sessionId,
        `no pending question with id '${requestId}'`
      );
    }
    await record.transport.replyQuestion(requestId, toQuestionAnswers(answers));
  }

  async setModel(sessionId: string, model: ModelSelection): Promise<void> {
    const record = this.require(sessionId);
    record.model = parseModelId(model.id);
  }

  async stopSession(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new ProviderSessionError('opencode', sessionId, 'unknown session');
    }
    record.stopping = true;
    await this.cancelPending(record);
    if (record.activeTurnId !== undefined) {
      this.completeTurn(record, record.activeTurnId, 'interrupted', 'session stopped');
    }
    await record.transport.dispose().catch((error: unknown) => {
      this.logger.warn('opencode: transport dispose failed', {
        sessionId,
        error: errorMessage(error),
      });
    });
    this.sessions.delete(sessionId);
    this.finishSession(record, 'session stopped');
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.stopSession(id)));
  }

  private require(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new ProviderSessionError('opencode', sessionId, 'unknown session');
    }
    if (record.stopping) {
      throw new ProviderSessionError('opencode', sessionId, 'session is stopping');
    }
    return record;
  }

  private async cancelPending(record: SessionRecord): Promise<void> {
    for (const requestId of [...record.pendingApprovals.keys()]) {
      record.pendingApprovals.delete(requestId);
      await record.transport.replyPermission(requestId, 'reject').catch(() => {});
      this.emit(record, { type: 'request.resolved', requestId, decision: 'cancel' });
    }
    for (const requestId of [...record.pendingQuestions.keys()]) {
      record.pendingQuestions.delete(requestId);
      await record.transport.rejectQuestion(requestId).catch(() => {});
      this.emit(record, { type: 'user-input.resolved', requestId });
    }
  }

  private handleUnexpectedExit(record: SessionRecord, reason: string): void {
    if (record.stopping || record.exited) return;
    this.sessions.delete(record.sessionId);
    this.emit(record, { type: 'runtime.error', message: reason });
    if (record.activeTurnId !== undefined) {
      this.completeTurn(record, record.activeTurnId, 'error', reason);
    }
    this.finishSession(record, reason);
  }

  private finishSession(record: SessionRecord, reason: string): void {
    if (record.exited) return;
    record.exited = true;
    this.clearAdmissionTimer(record);
    this.emitState(record, 'stopped');
    this.emit(record, { type: 'session.exited', reason });
  }

  private async pump(record: SessionRecord): Promise<void> {
    try {
      for await (const event of record.transport.events) {
        try {
          this.handleEvent(record, event);
        } catch (error) {
          this.logger.error('opencode: event handling failed', {
            sessionId: record.sessionId,
            error: errorMessage(error),
          });
        }
      }
    } catch (error) {
      if (record.stopping || record.exited) return;
      this.handleUnexpectedExit(record, `event stream failed: ${errorMessage(error)}`);
      return;
    }
    if (!record.stopping && !record.exited) {
      this.handleUnexpectedExit(record, 'event stream closed');
    }
  }

  private handleEvent(record: SessionRecord, event: OpencodeEvent): void {
    const properties = (event as { properties?: Record<string, unknown> }).properties ?? {};
    const sessionId = properties['sessionID'];
    if (typeof sessionId === 'string' && sessionId !== record.nativeSessionId) return;

    switch (event.type) {
      case 'session.status':
        this.handleStatus(record, event.properties.status.type, event);
        return;
      case 'session.idle':
        this.handleStatus(record, 'idle', event);
        return;
      case 'message.updated':
        record.messageRoles.set(event.properties.info.id, event.properties.info.role);
        return;
      case 'message.part.updated':
        this.handlePart(record, event.properties.part, event);
        return;
      case 'message.part.delta':
        this.handleDelta(record, event);
        return;
      case 'permission.asked':
        void this.handlePermissionAsked(record, event);
        return;
      case 'permission.replied': {
        const { requestID, reply } = event.properties;
        if (!record.pendingApprovals.delete(requestID)) return;
        this.emit(record, {
          type: 'request.resolved',
          requestId: requestID,
          decision: fromPermissionReply(reply),
        });
        return;
      }
      case 'question.asked':
        this.handleQuestionAsked(record, event);
        return;
      case 'question.replied':
      case 'question.rejected': {
        const { requestID } = event.properties;
        if (!record.pendingQuestions.delete(requestID)) return;
        this.emit(record, { type: 'user-input.resolved', requestId: requestID });
        return;
      }
      case 'session.error': {
        const error = event.properties.error;
        const name = error?.name;
        if (name === 'MessageAbortedError' && record.suppressAbortError) {
          record.suppressAbortError = false;
          return;
        }
        const detail = describeSessionError(error);
        if (record.activeTurnId !== undefined) {
          this.completeTurn(record, record.activeTurnId, 'error', detail);
        }
        this.emit(record, { type: 'runtime.error', message: detail }, undefined, event);
        return;
      }
      default:
        return;
    }
  }

  private handleStatus(
    record: SessionRecord,
    status: 'idle' | 'busy' | 'retry',
    event: OpencodeEvent
  ): void {
    if (status === 'retry') {
      this.emit(record, {
        type: 'runtime.warning',
        message: 'OpenCode is retrying the current request',
      });
      return;
    }
    if (status === 'busy') {
      record.awaitingBusy = false;
      this.clearAdmissionTimer(record);
      this.emitState(record, 'running');
      return;
    }
    this.emitState(record, 'ready');
    if (record.activeTurnId === undefined || record.awaitingBusy) return;
    this.completeTurn(record, record.activeTurnId, 'completed', undefined, event);
  }

  private handlePart(
    record: SessionRecord,
    part: Extract<OpencodeEvent, { type: 'message.part.updated' }>['properties']['part'],
    event: OpencodeEvent
  ): void {
    const turnId = record.activeTurnId;
    if (turnId === undefined) return;
    record.partTypes.set(part.id, part.type);

    if (part.type === 'text' || part.type === 'reasoning') {
      if (record.messageRoles.get(part.messageID) !== 'assistant') return;
      const isAssistantText = part.type === 'text';
      if (isAssistantText) this.flushText(record, turnId, part.id, part.text);
      const done = part.time?.end !== undefined;
      this.upsertItem(record, turnId, {
        id: part.id,
        type: isAssistantText ? 'assistant_message' : 'reasoning',
        status: done ? 'completed' : 'in_progress',
        title: isAssistantText ? 'Assistant message' : 'Reasoning',
        text: part.text,
      });
      return;
    }

    if (part.type !== 'tool') return;
    const state = part.state;
    const input = 'input' in state ? state.input : {};
    const type = toolItemType(part.tool, record.mcpNames);
    const status = toolItemStatus(state.status);
    this.upsertItem(record, turnId, {
      id: part.callID,
      type,
      status,
      title: toolTitle(type, part.tool, input, 'title' in state ? state.title : undefined),
      toolName: part.tool,
      ...(state.status === 'completed' ? { text: state.output } : {}),
      ...(state.status === 'error' ? { text: state.error } : {}),
      payload: { tool: part.tool, input, status: state.status },
    });
    void event;
  }

  private handleDelta(
    record: SessionRecord,
    event: Extract<OpencodeEvent, { type: 'message.part.delta' }>
  ): void {
    const turnId = record.activeTurnId;
    if (turnId === undefined) return;
    const { partID, field, delta, messageID } = event.properties;
    if (field !== 'text' || delta.length === 0) return;
    if (record.partTypes.get(partID) !== 'text') return;
    if (record.messageRoles.get(messageID) !== 'assistant') return;
    const emitted = record.emittedText.get(partID) ?? '';
    record.emittedText.set(partID, emitted + delta);
    this.emit(record, { type: 'content.delta', itemId: partID, delta }, turnId, event);
  }

  /** OpenCode both streams deltas and re-sends whole text; emit only the tail. */
  private flushText(record: SessionRecord, turnId: string, partId: string, text: string): void {
    const emitted = record.emittedText.get(partId) ?? '';
    if (!text.startsWith(emitted) || text.length === emitted.length) return;
    const delta = text.slice(emitted.length);
    record.emittedText.set(partId, text);
    this.emit(record, { type: 'content.delta', itemId: partId, delta }, turnId);
  }

  private upsertItem(record: SessionRecord, turnId: string, item: ProviderItem): void {
    const seen = record.items.has(item.id);
    record.items.set(item.id, item);
    if (!seen) this.emit(record, { type: 'item.started', item }, turnId);
    if (item.status === 'in_progress') {
      if (seen) this.emit(record, { type: 'item.updated', item }, turnId);
      return;
    }
    this.emit(record, { type: 'item.completed', item }, turnId);
  }

  private async handlePermissionAsked(
    record: SessionRecord,
    event: Extract<OpencodeEvent, { type: 'permission.asked' }>
  ): Promise<void> {
    const { id, permission, patterns, metadata } = event.properties;
    if (record.runtimeMode === 'full-access') {
      // Doom-loop detection and subagent sessions are evaluated against rules
      // that never include the session ruleset, so full access still has to
      // answer them. `once` rather than `always`: OpenCode remembers `always`
      // per directory, where another session could inherit it.
      this.logger.debug('opencode: auto-allowing a permission ask in full access', {
        sessionId: record.sessionId,
        permission,
      });
      await record.transport.replyPermission(id, 'once').catch((error: unknown) => {
        this.logger.error('opencode: could not auto-allow a permission ask', {
          sessionId: record.sessionId,
          error: errorMessage(error),
        });
      });
      return;
    }
    const turnId = record.activeTurnId;
    if (turnId === undefined) return;
    record.pendingApprovals.set(id, { turnId });
    this.emit(
      record,
      {
        type: 'request.opened',
        requestId: id,
        requestType: toRequestType(permission, record.mcpNames),
        title: patterns[0] ?? permission,
        ...(typeof metadata['command'] === 'string' ? { detail: metadata['command'] } : {}),
        options: APPROVAL_OPTIONS,
      },
      turnId,
      event
    );
  }

  private handleQuestionAsked(
    record: SessionRecord,
    event: Extract<OpencodeEvent, { type: 'question.asked' }>
  ): void {
    const turnId = record.activeTurnId;
    if (turnId === undefined) return;
    const { id, questions } = event.properties;
    record.pendingQuestions.set(id, { turnId });
    this.emit(
      record,
      {
        type: 'user-input.requested',
        requestId: id,
        questions: questions.map(
          (question, index): UserInputQuestion => ({
            id: String(index),
            ...(question.header ? { header: question.header } : {}),
            question: question.question,
            options: question.options.map((option) => ({
              label: option.label,
              value: option.label,
              ...(option.description ? { description: option.description } : {}),
            })),
            multiSelect: question.multiple === true,
            allowCustomAnswer: question.custom === true,
          })
        ),
      },
      turnId,
      event
    );
  }

  private armAdmissionTimer(record: SessionRecord, turnId: string): void {
    this.clearAdmissionTimer(record);
    const timer = setTimeout(() => {
      void this.reconcileAdmission(record, turnId);
    }, this.admissionTimeoutMs);
    timer.unref?.();
    record.admissionTimer = timer;
  }

  private clearAdmissionTimer(record: SessionRecord): void {
    if (record.admissionTimer === undefined) return;
    clearTimeout(record.admissionTimer);
    record.admissionTimer = undefined;
  }

  /**
   * OpenCode reports `busy` as soon as it admits a prompt. If that never
   * arrives the turn would wait on an `idle` that already went past, so poll
   * the session's real status and say so rather than hanging.
   */
  private async reconcileAdmission(record: SessionRecord, turnId: string): Promise<void> {
    if (record.activeTurnId !== turnId || !record.awaitingBusy || record.stopping) return;
    const status = await record.transport.sessionStatus();
    if (record.activeTurnId !== turnId || !record.awaitingBusy) return;
    if (status === 'idle') {
      this.emit(record, {
        type: 'runtime.warning',
        message:
          'OpenCode never reported the prompt as running; completing the turn from session status',
      });
      record.awaitingBusy = false;
      this.completeTurn(record, turnId, 'completed');
      return;
    }
    record.awaitingBusy = false;
  }

  private completeTurn(
    record: SessionRecord,
    turnId: string,
    outcome: TurnOutcome,
    message?: string,
    raw?: OpencodeEvent
  ): void {
    if (record.activeTurnId !== turnId) return;
    record.activeTurnId = undefined;
    record.awaitingBusy = false;
    this.clearAdmissionTimer(record);
    this.emit(
      record,
      {
        type: 'turn.completed',
        outcome,
        ...(message !== undefined ? { message } : {}),
      },
      turnId,
      raw
    );
  }

  private emitState(record: SessionRecord, status: SessionStatus): void {
    this.emit(record, { type: 'session.state.changed', status });
  }

  private emit(
    record: SessionRecord,
    body: ProviderEventBody,
    turnId?: string,
    raw?: OpencodeEvent
  ): void {
    this.publish({
      ...body,
      eventId: randomUUID(),
      provider: 'opencode',
      sessionId: record.sessionId,
      createdAt: new Date().toISOString(),
      ...(turnId !== undefined ? { turnId } : {}),
      ...(raw !== undefined ? { raw: { source: 'opencode', payload: raw } } : {}),
    } as ProviderRuntimeEvent);
  }

  private publish(event: ProviderRuntimeEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error('opencode: an event listener threw', { error: errorMessage(error) });
      }
    }
  }
}

export function createOpencodeAdapter(options: OpencodeAdapterOptions = {}): OpencodeAdapter {
  return new OpencodeAdapter(options);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function describeSessionError(error: { name?: string; data?: unknown } | undefined): string {
  if (error === undefined) return 'OpenCode reported an error with no detail';
  const data = error.data;
  if (data !== null && typeof data === 'object' && 'message' in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === 'string') return `${error.name ?? 'error'}: ${message}`;
  }
  return error.name ?? 'OpenCode reported an unnamed error';
}

export function toPermissionReply(decision: ApprovalDecision): OpencodePermissionReply {
  switch (decision) {
    case 'accept':
      return 'once';
    case 'acceptForSession':
      return 'always';
    default:
      return 'reject';
  }
}

export function fromPermissionReply(reply: OpencodePermissionReply): ApprovalDecision {
  switch (reply) {
    case 'once':
      return 'accept';
    case 'always':
      return 'acceptForSession';
    default:
      return 'decline';
  }
}

/** Answers are positional in OpenCode: one `string[]` per question, in order. */
export function toQuestionAnswers(answers: UserInputAnswers): string[][] {
  const indexes = Object.keys(answers)
    .map((key) => Number(key))
    .filter((index) => Number.isInteger(index) && index >= 0);
  const size = indexes.length === 0 ? 0 : Math.max(...indexes) + 1;
  const positional: string[][] = [];
  for (let index = 0; index < size; index += 1) {
    const answer = answers[String(index)];
    positional.push(answer === undefined ? [] : Array.isArray(answer) ? answer : [answer]);
  }
  return positional;
}

export function toolItemType(tool: string, mcpNames: string[]): ItemType {
  const name = tool.toLowerCase();
  if (mcpNames.some((mcp) => name.startsWith(`${mcp.toLowerCase()}_`))) return 'mcp_tool_call';
  if (name.includes('task') || name.includes('subtask') || name.includes('subagent')) {
    return 'subagent';
  }
  if (name.includes('bash') || name.includes('shell')) return 'command_execution';
  if (name.includes('edit') || name.includes('write') || name.includes('patch'))
    return 'file_change';
  if (name.includes('websearch') || name.includes('webfetch')) return 'web_search';
  return 'tool_call';
}

function toolItemStatus(status: 'pending' | 'running' | 'completed' | 'error'): ItemStatus {
  if (status === 'completed') return 'completed';
  if (status === 'error') return 'failed';
  return 'in_progress';
}

function toolTitle(
  type: ItemType,
  tool: string,
  input: Record<string, unknown>,
  stateTitle: string | undefined
): string {
  const pick = (key: string): string | undefined => {
    const value = input[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  if (type === 'command_execution') return pick('command') ?? stateTitle ?? tool;
  if (type === 'file_change') return pick('filePath') ?? stateTitle ?? tool;
  if (type === 'subagent') {
    return pick('description') ?? pick('prompt')?.slice(0, 120) ?? stateTitle ?? tool;
  }
  return stateTitle ?? tool;
}

export function toRequestType(permission: string, mcpNames: string[]): RequestType {
  const name = permission.toLowerCase();
  if (mcpNames.some((mcp) => name.startsWith(`${mcp.toLowerCase()}_`))) return 'mcp_tool_approval';
  if (name === 'bash') return 'command_execution_approval';
  if (name === 'edit' || name === 'write' || name === 'patch') return 'file_change_approval';
  if (name === 'external_directory') return 'directory_access_approval';
  return 'tool_approval';
}
