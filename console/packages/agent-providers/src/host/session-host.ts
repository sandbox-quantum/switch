import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  SessionReplica,
  commandSchema,
  eventBytes,
  serverEventSchema,
} from '@switch-console/shared/session-v1';
import type {
  Attachment,
  Command,
  HostBody,
  Request,
  ServerEvent,
  Session,
  Snapshot,
} from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { ProviderConversationUnavailableError } from '../adapter';
import type { ProviderAdapter, ProviderSessionStartInput, TurnAttachment } from '../adapter';
import type { UserInputAnswers } from '../events';
import type { ProviderRuntimeEvent } from '../events';
import { ChatProjector } from '../session-v1/chat-projector';
import { ATTACHMENT_MIME_TYPES } from './attachments';
import { Journal } from './journal';

const recordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('accepted'), command: commandSchema }),
  z.object({ type: z.literal('dispatched'), commandId: z.string() }),
  z.object({ type: z.literal('finished'), commandId: z.string() }),
  z.object({ type: z.literal('native'), nativeSessionId: z.string() }),
  z.object({ type: z.literal('stopped') }),
  z.object({ type: z.literal('reset-started') }),
  z.object({ type: z.literal('reset-completed') }),
  z.object({ type: z.literal('model'), id: z.string(), options: z.record(z.string(), z.string()) }),
]);
type RecordEntry = z.infer<typeof recordSchema>;
export type HostSessionStart = {
  session: Session;
  input: ProviderSessionStartInput;
  epochAuthority?: 'server';
  resetEpoch?: () => Promise<string>;
  stageAttachments?: (attachments: Attachment[]) => Promise<TurnAttachment[]>;
};
type PendingQuestion = { request: Request; options: Map<string, string> };

/** Execution owner for a local-only session. Shared server leases are an external boundary. */
export class HostedSession {
  private readonly projector: ChatProjector;
  private replica: SessionReplica;
  private readonly commands = new Map<string, Command>();
  private readonly dispatched = new Set<string>();
  private readonly finished = new Set<string>();
  private readonly queue: Command[] = [];
  private readonly questions = new Map<string, PendingQuestion>();
  private activeTurn: string | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private eventSerial: Promise<unknown> = Promise.resolve();
  private publishing: Promise<unknown> = Promise.resolve();
  private nativeId: string | null = null;
  private fault: Error | null = null;
  private shuttingDown = false;
  private stopped = false;
  private resetting = false;
  private resetPending = false;
  private decisionPending = false;
  private decisionCode = 'RESET_OUTCOME_UNKNOWN';
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;

  private constructor(
    readonly config: HostSessionStart,
    private readonly adapter: ProviderAdapter,
    private readonly events: Journal<ServerEvent>,
    private readonly inbox: Journal<RecordEntry>
  ) {
    const snapshot: Snapshot = {
      contractVersion: 1,
      throughSequence: 0,
      session: structuredClone(config.session),
      turns: [],
      items: [],
      requests: [],
      commandStatuses: [],
      nextPageToken: null,
    };
    // Replay old history before announcing the recovered generation.
    const first = events.records.find((event) => event.body.type === 'session.upsert');
    if (first?.body.type === 'session.upsert')
      snapshot.session = structuredClone(first.body.session);
    this.replica = new SessionReplica(snapshot);
    for (const event of events.records) {
      if (
        event.body.type === 'session.upsert' &&
        event.body.session.epoch !== this.replica.snapshot().session.epoch
      ) {
        const prior = this.replica.snapshot();
        prior.session = event.body.session;
        this.replica = new SessionReplica(prior);
      }
      this.replica.apply(event);
    }
    for (const record of inbox.records) {
      if (record.type === 'accepted') this.commands.set(record.command.commandId, record.command);
      if (record.type === 'dispatched') this.dispatched.add(record.commandId);
      if (record.type === 'finished') this.finished.add(record.commandId);
      if (record.type === 'native') this.nativeId = record.nativeSessionId;
      if (record.type === 'stopped') this.stopped = true;
      if (record.type === 'reset-started') {
        this.nativeId = null;
        this.resetPending = true;
      }
      if (record.type === 'reset-completed') this.resetPending = false;
      if (record.type === 'model') config.input.model = { id: record.id, options: record.options };
    }
    this.projector = new ChatProjector(config.session);
    this.unsubscribe = adapter.subscribe((event) => {
      if (event.sessionId !== config.session.sessionId) return;
      this.eventSerial = this.eventSerial
        .then(() => this.providerEvent(event))
        .catch((error: unknown) => this.fail(error));
    });
    this.timer = setInterval(() => {
      this.eventSerial = this.eventSerial
        .then(() => this.publishAll(this.projector.flush(Date.now(), false)))
        .catch((error: unknown) => this.fail(error));
    }, 250);
    this.timer.unref();
  }

  static async start(
    root: string,
    config: HostSessionStart,
    adapter: ProviderAdapter
  ): Promise<HostedSession> {
    const events = await Journal.load(join(root, 'events.jsonl'), (input) =>
      serverEventSchema.parse(input)
    );
    const inbox = await Journal.load(join(root, 'inbox.jsonl'), (input) =>
      recordSchema.parse(input)
    );
    const host = new HostedSession(config, adapter, events, inbox);
    try {
      const recovered = events.records.length > 0;
      if (recovered) {
        const snapshot = host.replica.snapshot();
        for (const request of snapshot.requests)
          if (request.state === 'open' || request.state === 'submitting')
            await host.publish({
              type: 'request.settled',
              requestId: request.requestId,
              revision: request.revision + 1,
              outcome: 'interrupted',
              commandId: null,
              result: null,
            });
        for (const turn of snapshot.turns)
          if (turn.status === 'running' || turn.status === 'queued')
            await host.publish({ ...turn, status: 'interrupted' });
        for (const command of host.commands.values()) {
          const status = host
            .snapshot()
            .commandStatuses.find((s) => s.commandId === command.commandId);
          if (!status || status.status === 'accepted' || status.status === 'dispatched')
            await host.publish({
              type: 'command.status',
              commandId: command.commandId,
              status: 'unknown',
              code: 'HOST_RESTARTED',
              message: 'The host restarted before confirming the command. It will not resend it.',
            });
          if (command.body.type === 'message.send' && !host.finished.has(command.commandId))
            await host.publish({
              type: 'notice',
              level: 'warning',
              code: 'TURN_INTERRUPTED',
              message: host.dispatched.has(command.commandId)
                ? 'The host restarted during a turn. Its execution outcome is uncertain; the turn was not resent.'
                : 'A queued turn was interrupted by the host restart and was not sent to the provider.',
            });
        }
        if (host.stopped) {
          host.config.session = { ...config.session, status: 'stopped' };
          const stoppedSnapshot = host.replica.snapshot();
          stoppedSnapshot.session = host.config.session;
          host.replica = new SessionReplica(stoppedSnapshot);
          await host.publish({ type: 'session.upsert', session: host.config.session });
          clearInterval(host.timer);
          host.unsubscribe();
          return host;
        }
        if (host.resetPending) {
          await host.awaitResetDecision(
            'RESET_OUTCOME_UNKNOWN',
            'A reset was interrupted and its outcome is unknown. Start a fresh conversation to continue; earlier messages stay in the transcript.'
          );
          return host;
        }
        if (!host.nativeId)
          throw new Error('Cannot recover a session without its native provider ID.');
        if (config.epochAuthority !== 'server') config.session.epoch = randomUUID();
        const next = host.replica.snapshot();
        config.session.models = next.session.models;
        next.session = structuredClone(config.session);
        host.replica = new SessionReplica(next);
      }
      await host.publish({ type: 'session.upsert', session: structuredClone(config.session) });
      const native = await adapter.startSession({
        ...config.input,
        ...(host.nativeId ? { resume: { nativeSessionId: host.nativeId } } : {}),
      });
      await host.inbox.append({ type: 'native', nativeSessionId: native.nativeSessionId });
      host.nativeId = native.nativeSessionId;
      await host.eventSerial;
      await host.refreshModels();
      return host;
    } catch (error) {
      if (error instanceof ProviderConversationUnavailableError && host.nativeId) {
        await host.eventSerial;
        await host.awaitResetDecision('NATIVE_CONVERSATION_UNAVAILABLE', error.message);
        return host;
      }
      await host.fail(error);
      await host.shutdown();
      throw error;
    }
  }

  private async awaitResetDecision(code: string, message: string): Promise<void> {
    this.decisionPending = true;
    this.decisionCode = code;
    this.queue.length = 0;
    this.activeTurn = null;
    this.config.session.status = 'error';
    this.config.session.capabilities = {
      ...this.config.session.capabilities,
      reset: true,
      modelChange: false,
      compact: false,
      attachmentMimeTypes: [],
    };
    const snapshot = this.replica.snapshot();
    snapshot.session = structuredClone(this.config.session);
    this.replica = new SessionReplica(snapshot);
    await this.publish({ type: 'session.upsert', session: structuredClone(this.config.session) });
    await this.publish({ type: 'notice', level: 'error', code, message });
  }

  private async refreshModels(): Promise<void> {
    this.config.session.capabilities.compact =
      Boolean(this.adapter.compactSession) &&
      (!this.adapter.canCompact || (await this.adapter.canCompact(this.config.session.sessionId)));
    if (!this.adapter.listModels) {
      this.updateAttachmentCapabilities();
      await this.publish({ type: 'session.upsert', session: structuredClone(this.config.session) });
      return;
    }
    let models = await this.adapter.listModels(this.config.session.sessionId);
    const previousModels = this.replica.snapshot().session.models;
    if (!models.length && previousModels?.length) {
      models = previousModels;
      await this.publish({
        type: 'notice',
        level: 'warning',
        code: 'MODEL_CATALOG_CACHED',
        message:
          'The provider did not return a model catalog on resume. Showing the last known choices; the provider will validate each change.',
      });
    }
    this.config.session.models = models;
    this.config.session.model = this.config.input.model
      ? { id: this.config.input.model.id, options: this.config.input.model.options ?? {} }
      : null;
    this.config.session.capabilities.modelChange = Boolean(models.length && this.adapter.setModel);
    this.updateAttachmentCapabilities();
    await this.publish({ type: 'session.upsert', session: structuredClone(this.config.session) });
  }

  private updateAttachmentCapabilities(): void {
    const session = this.config.session;
    const model = session.models?.find((entry) => entry.id === session.model?.id);
    session.capabilities.attachmentMimeTypes = this.config.stageAttachments
      ? ATTACHMENT_MIME_TYPES.filter(
          (mime) => model?.imageInput !== false || !mime.startsWith('image/')
        )
      : [];
  }

  notice(message: string): Promise<void> {
    return this.publish({ type: 'notice', level: 'error', code: 'ROOM_DELIVERY_FAILED', message });
  }

  roomBacklogDelivered(count: number): Promise<void> {
    return this.publish({
      type: 'notice',
      level: 'info',
      code: 'ROOM_BACKLOG_DELIVERED',
      message: `${count} room message(s) received while the conversation needed an explicit reset are now being delivered to the fresh conversation.`,
    });
  }

  /** A conversation that cannot continue without an explicit reset. */
  get resetDecisionPending(): boolean {
    return this.decisionPending;
  }

  snapshot(): Snapshot {
    return this.replica.snapshot();
  }
  replay(after: number): { events: ServerEvent[]; throughSequence: number } {
    return {
      events: structuredClone(this.events.records.filter((event) => event.sequence > after)),
      throughSequence: this.replica.snapshot().throughSequence,
    };
  }

  command(input: Command): Promise<Snapshot['commandStatuses'][number]> {
    const command = commandSchema.parse(input);
    const result = this.serial.then(() => this.accept(command));
    this.serial = result.catch(() => {});
    return result;
  }

  private async accept(command: Command): Promise<Snapshot['commandStatuses'][number]> {
    if (this.shuttingDown) throw new Error('HOST_STOPPING');
    const { session } = this.snapshot();
    if (command.sessionId !== session.sessionId) throw new Error('NOT_FOUND: session mismatch.');
    const previous = this.commands.get(command.commandId);
    if (previous) {
      if (!isDeepStrictEqual(previous, command)) throw new Error('IDEMPOTENCY_CONFLICT');
      return this.status(command.commandId);
    }
    if (this.fault) throw this.fault;
    if (command.epoch !== session.epoch) throw new Error('STALE_EPOCH');
    const body = command.body;
    if (this.decisionPending && body.type !== 'session.reset' && body.type !== 'session.stop')
      throw new Error(
        `UNSUPPORTED_CAPABILITY: ${this.decisionCode} — start a fresh conversation first.`
      );
    if (body.type === 'message.send') {
      if (this.stopped) throw new Error('Session stop has been requested.');
      if (body.delivery !== 'queue')
        throw new Error('UNSUPPORTED_CAPABILITY: host currently accepts queued messages.');
      if (eventBytes(command) > 60 * 1024)
        throw new Error('PAYLOAD_TOO_LARGE: message exceeds the local host limit.');
      if (body.attachments.length && !this.config.stageAttachments)
        throw new Error('UNSUPPORTED_CAPABILITY: attachment staging is not configured.');
      if (
        body.attachments.some(
          (file) => !session.capabilities.attachmentMimeTypes.includes(file.mimeType)
        )
      )
        throw new Error(
          'UNSUPPORTED_CAPABILITY: the selected provider model does not accept this attachment type.'
        );
      if (session.status !== 'ready' && session.status !== 'running')
        throw new Error('Session is not ready.');
    } else if (
      body.type !== 'turn.interrupt' &&
      body.type !== 'session.stop' &&
      body.type !== 'session.reset' &&
      body.type !== 'session.compact' &&
      body.type !== 'session.model.set' &&
      body.type !== 'request.answer'
    )
      throw new Error('UNSUPPORTED_CAPABILITY');
    if (
      body.type === 'session.reset' ||
      body.type === 'session.model.set' ||
      body.type === 'session.compact'
    ) {
      const decisionReset =
        this.decisionPending && body.type === 'session.reset' && session.status === 'error';
      if (
        this.activeTurn ||
        this.queue.length ||
        (session.status !== 'ready' && !decisionReset) ||
        this.snapshot().requests.some((r) => r.state === 'open' || r.state === 'submitting')
      )
        throw new Error('SESSION_BUSY: finish or interrupt the current turn first.');
      if (
        body.type === 'session.reset' &&
        (!session.capabilities.reset ||
          (this.config.epochAuthority === 'server' && !this.config.resetEpoch))
      )
        throw new Error('UNSUPPORTED_CAPABILITY: reset needs a generation authority.');
      if (
        body.type === 'session.compact' &&
        (!session.capabilities.compact || !this.adapter.compactSession)
      )
        throw new Error('UNSUPPORTED_CAPABILITY: native compaction is unavailable.');
      if (
        body.type === 'session.model.set' &&
        (!session.capabilities.modelChange || !this.adapter.setModel)
      )
        throw new Error('UNSUPPORTED_CAPABILITY: model changes are unavailable.');
    }
    if (body.type === 'session.model.set') {
      const model = session.models?.find((entry) => entry.id === body.modelId);
      if (
        !model ||
        Object.entries(body.options).some(([key, value]) => !model.options[key]?.includes(value))
      )
        throw new Error('UNSUPPORTED_MODEL: choose an offered model and options.');
    }
    if (body.type === 'request.answer') this.validateAnswer(command);
    await this.inbox.append({ type: 'accepted', command });
    this.commands.set(command.commandId, command);
    await this.publish({
      type: 'command.status',
      commandId: command.commandId,
      status: 'accepted',
      code: null,
      message: null,
    });
    try {
      if (body.type === 'message.send') {
        const turnId = command.commandId;
        this.projector.bindTurn(turnId, {
          commandId: command.commandId,
          origin: command.origin,
        });
        await this.publish({
          type: 'turn.upsert',
          turnId,
          commandId: command.commandId,
          status: 'queued',
        });
        await this.publish({
          type: 'item.upsert',
          item: {
            itemId: `user-${command.commandId}`,
            turnId,
            revision: 1,
            kind: 'user-message',
            status: 'completed',
            title: '',
            text: body.text,
            attachments: body.attachments,
            origin: command.origin,
          },
        });
        this.queue.push(command);
      } else if (body.type === 'session.compact') {
        await this.inbox.append({ type: 'dispatched', commandId: command.commandId });
        this.dispatched.add(command.commandId);
        this.config.session.status = 'running';
        await this.publish({
          type: 'session.upsert',
          session: structuredClone(this.config.session),
        });
        await this.publish({
          type: 'notice',
          level: 'info',
          code: 'COMPACTION_STARTED',
          message: 'Compacting provider context…',
        });
        let timeout: ReturnType<typeof setTimeout>;
        try {
          await Promise.race([
            this.adapter.compactSession!(session.sessionId),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Native compaction outcome is unknown after 180 seconds.')),
                180000
              );
            }),
          ]);
          await this.eventSerial;
          await this.publish({
            type: 'notice',
            level: 'info',
            code: 'COMPACTION_COMPLETED',
            message: 'Provider context compaction completed. The transcript remains available.',
          });
          this.config.session.status = 'ready';
          await this.publish({
            type: 'session.upsert',
            session: structuredClone(this.config.session),
          });
        } catch (error) {
          await this.fail(error);
          throw error;
        } finally {
          clearTimeout(timeout!);
        }
      } else if (body.type === 'session.model.set') {
        await this.inbox.append({ type: 'dispatched', commandId: command.commandId });
        this.dispatched.add(command.commandId);
        await this.adapter.setModel!(session.sessionId, {
          id: body.modelId,
          options: body.options,
        });
        await this.inbox.append({ type: 'model', id: body.modelId, options: body.options });
        this.config.input.model = { id: body.modelId, options: body.options };
        this.config.session.model = { id: body.modelId, options: body.options };
        this.updateAttachmentCapabilities();
        await this.publish({
          type: 'session.upsert',
          session: structuredClone(this.config.session),
        });
        await this.publish({
          type: 'notice',
          level: 'info',
          code: 'MODEL_CHANGED',
          message: `Model changed to ${body.modelId}.`,
        });
      } else if (body.type === 'session.reset') {
        await this.inbox.append({ type: 'dispatched', commandId: command.commandId });
        this.dispatched.add(command.commandId);
        await this.inbox.append({ type: 'reset-started' });
        this.nativeId = null;
        this.resetPending = true;
        this.resetting = true;
        try {
          if (this.adapter.hasSession(session.sessionId))
            await this.adapter.stopSession(session.sessionId);
          await this.eventSerial;
          const epoch = this.config.resetEpoch ? await this.config.resetEpoch() : randomUUID();
          this.config.session.epoch = epoch;
          this.config.session.status = 'starting';
          const snapshot = this.snapshot();
          snapshot.session = structuredClone(this.config.session);
          this.replica = new SessionReplica(snapshot);
          await this.publish({
            type: 'session.upsert',
            session: structuredClone(this.config.session),
          });
          const { resume: _resume, ...fresh } = this.config.input;
          const native = await this.adapter.startSession(fresh);
          await this.inbox.append({ type: 'native', nativeSessionId: native.nativeSessionId });
          this.nativeId = native.nativeSessionId;
          await this.eventSerial;
          await this.inbox.append({ type: 'reset-completed' });
          this.resetPending = false;
          this.decisionPending = false;
          await this.refreshModels();
          await this.publish({
            type: 'notice',
            level: 'info',
            code: 'CONTEXT_RESET',
            message:
              'Started a fresh provider conversation. Earlier messages remain in the transcript for reference.',
          });
        } catch (error) {
          await this.fail(error);
          throw error;
        } finally {
          this.resetting = false;
        }
      } else if (body.type === 'turn.interrupt') {
        if (body.turnId !== this.activeTurn) throw new Error('Turn is no longer active.');
        await this.inbox.append({ type: 'dispatched', commandId: command.commandId });
        this.dispatched.add(command.commandId);
        await this.adapter.interruptTurn(session.sessionId);
      } else if (body.type === 'session.stop') {
        await this.inbox.append({ type: 'dispatched', commandId: command.commandId });
        this.dispatched.add(command.commandId);
        await this.inbox.append({ type: 'stopped' });
        this.stopped = true;
        for (const queued of this.queue)
          await this.publish({
            type: 'turn.upsert',
            turnId: queued.commandId,
            commandId: queued.commandId,
            status: 'interrupted',
          });
        this.queue.length = 0;
        if (this.adapter.hasSession(session.sessionId))
          await this.adapter.stopSession(session.sessionId);
        else {
          this.config.session.status = 'stopped';
          await this.publish({
            type: 'session.upsert',
            session: structuredClone(this.config.session),
          });
        }
      } else await this.answer(command);
      await this.publish({
        type: 'command.status',
        commandId: command.commandId,
        status: 'applied',
        code: null,
        message: null,
      });
      if (body.type === 'message.send')
        void this.runNext().catch((error: unknown) => this.fail(error));
    } catch (error) {
      if (body.type === 'session.model.set') await this.fail(error);
      if (body.type === 'request.answer') {
        const request = this.snapshot().requests.find((r) => r.requestId === body.requestId);
        if (request?.state === 'submitting')
          await this.publish({
            type: 'request.settled',
            requestId: request.requestId,
            revision: request.revision + 1,
            outcome: 'provider-error',
            commandId: command.commandId,
            result: null,
          });
      }
      await this.publish({
        type: 'command.status',
        commandId: command.commandId,
        status: this.dispatched.has(command.commandId) ? 'unknown' : 'rejected',
        code: this.dispatched.has(command.commandId) ? 'OUTCOME_UNKNOWN' : 'PROVIDER_ERROR',
        message: String(error),
      });
    }
    return this.status(command.commandId);
  }

  async reject(command: Command, error: unknown): Promise<void> {
    if (this.fault || this.commands.has(command.commandId)) throw error;
    await this.inbox.append({ type: 'accepted', command });
    this.commands.set(command.commandId, command);
    await this.publish({
      type: 'command.status',
      commandId: command.commandId,
      status: 'rejected',
      code: 'COMMAND_REJECTED',
      message: String(error),
    });
  }

  status(commandId: string): Snapshot['commandStatuses'][number] {
    const status = this.snapshot().commandStatuses.find((value) => value.commandId === commandId);
    if (!status) throw new Error('NOT_FOUND: command not found.');
    return status;
  }

  private async runNext(): Promise<void> {
    if (this.activeTurn || this.shuttingDown || this.stopped || this.fault) return;
    const command = this.queue.shift();
    if (!command || command.body.type !== 'message.send') return;
    this.activeTurn = command.commandId;
    try {
      const attachments = command.body.attachments.length
        ? await this.config.stageAttachments!(command.body.attachments)
        : [];
      if (this.shuttingDown || this.stopped || this.fault) throw new Error('HOST_STOPPING');
      await this.inbox.append({ type: 'dispatched', commandId: command.commandId });
      this.dispatched.add(command.commandId);
      await this.adapter.sendTurn({
        sessionId: this.config.session.sessionId,
        turnId: command.commandId,
        text: command.body.text,
        attachments,
      });
    } catch (error) {
      await this.publish({
        type: 'turn.upsert',
        turnId: command.commandId,
        commandId: command.commandId,
        status: 'error',
      });
      await this.publish({
        type: 'notice',
        level: 'error',
        code: 'TURN_FAILED',
        message: String(error),
      });
      this.activeTurn = null;
      void this.runNext().catch((error: unknown) => this.fail(error));
    }
  }

  private async providerEvent(event: ProviderRuntimeEvent): Promise<void> {
    if (this.resetting && event.type === 'session.exited') return;
    if (event.type === 'session.exited') {
      for (const request of this.snapshot().requests)
        if (request.state === 'open' || request.state === 'submitting')
          await this.publish({
            type: 'request.settled',
            requestId: request.requestId,
            revision: request.revision + 1,
            outcome: 'interrupted',
            commandId: null,
            result: null,
          });
      for (const turn of this.snapshot().turns)
        if (turn.status === 'running' || turn.status === 'queued')
          await this.publish({ ...turn, status: 'interrupted' });
      this.queue.length = 0;
      this.activeTurn = null;
      this.questions.clear();
    }
    if (event.type === 'session.started') {
      this.nativeId = event.nativeSessionId;
      await this.inbox.append({ type: 'native', nativeSessionId: event.nativeSessionId });
    }
    if (event.type === 'runtime.error' || event.type === 'runtime.warning')
      await this.publish({
        type: 'notice',
        level: event.type === 'runtime.error' ? 'error' : 'warning',
        code: 'PROVIDER_NOTICE',
        message: event.message,
      });
    if (event.type === 'request.opened' || event.type === 'user-input.requested') {
      const options = new Map<string, string>();
      const request: Request = {
        requestId: event.requestId,
        turnId: event.turnId,
        revision: 1,
        state: 'open',
        expiresAt: null,
        content:
          event.type === 'request.opened'
            ? {
                kind: 'approval',
                title: event.title,
                detail: event.detail ?? null,
                options: event.options.map((option, index) => ({
                  ...option,
                  optionId: String(index),
                })),
              }
            : {
                kind: 'questions',
                title: 'Question from the agent',
                questions: event.questions.map((question) => ({
                  questionId: question.id,
                  title: question.header ?? '',
                  prompt: question.question,
                  multiSelect: question.multiSelect,
                  allowCustomAnswer: question.allowCustomAnswer,
                  options: question.options.map((option, index) => {
                    const optionId = `${question.id}:${index}`;
                    options.set(optionId, option.value);
                    return {
                      optionId,
                      label: option.label,
                      description: option.description ?? null,
                    };
                  }),
                })),
              },
      };
      this.questions.set(request.requestId, { request, options });
      await this.publish({ type: 'request.opened', request });
    }
    if (event.type === 'request.resolved' || event.type === 'user-input.resolved') {
      const request = this.snapshot().requests.find((r) => r.requestId === event.requestId);
      if (request?.state === 'open')
        await this.publish({
          type: 'request.settled',
          requestId: request.requestId,
          revision: request.revision + 1,
          outcome: 'interrupted',
          commandId: null,
          result: null,
        });
    }
    if (
      (event.type === 'item.started' ||
        event.type === 'item.updated' ||
        event.type === 'item.completed') &&
      event.item.type === 'user_message'
    )
      return;
    await this.publishAll(this.projector.ingest(event, Date.now()));
    if (event.type === 'turn.completed') {
      await this.inbox.append({ type: 'finished', commandId: event.turnId });
      this.finished.add(event.turnId);
      this.activeTurn = null;
      void this.runNext().catch((error: unknown) => this.fail(error));
    }
  }

  private validateAnswer(command: Command): PendingQuestion {
    if (command.body.type !== 'request.answer') throw new Error('INVALID_ANSWER');
    const body = command.body;
    const pending = this.questions.get(body.requestId);
    const current = this.snapshot().requests.find((r) => r.requestId === body.requestId);
    if (!pending || current?.state !== 'open') throw new Error('REQUEST_CLOSED');
    if (current.revision !== body.expectedRevision) throw new Error('STALE_REVISION');
    if (body.answer.kind !== pending.request.content.kind) throw new Error('INVALID_ANSWER');
    if (body.answer.kind === 'approval' && pending.request.content.kind === 'approval') {
      if (
        !pending.request.content.options.some(
          (x) => x.optionId === (body.answer as { optionId: string }).optionId
        )
      )
        throw new Error('INVALID_ANSWER');
    } else if (body.answer.kind === 'questions' && pending.request.content.kind === 'questions') {
      const answers = body.answer.answers;
      if (
        new Set(answers.map((a) => a.questionId)).size !==
          pending.request.content.questions.length ||
        answers.length !== pending.request.content.questions.length
      )
        throw new Error('INVALID_ANSWER');
      for (const question of pending.request.content.questions) {
        const answer = answers.find((a) => a.questionId === question.questionId);
        if (!answer) throw new Error('INVALID_ANSWER');
        const custom = Boolean(answer.customText?.trim());
        if (custom && !question.allowCustomAnswer) throw new Error('INVALID_ANSWER');
        if (
          answer.selectedOptionIds.some((id) => !question.options.some((o) => o.optionId === id)) ||
          new Set(answer.selectedOptionIds).size !== answer.selectedOptionIds.length
        )
          throw new Error('INVALID_ANSWER');
        if (
          question.multiSelect
            ? !custom && !answer.selectedOptionIds.length
            : Number(custom) + answer.selectedOptionIds.length !== 1
        )
          throw new Error('INVALID_ANSWER');
      }
    }
    return pending;
  }

  private async answer(command: Command): Promise<void> {
    if (command.body.type !== 'request.answer') return;
    const body = command.body;
    const pending = this.validateAnswer(command);
    await this.publish({
      type: 'request.submitting',
      requestId: body.requestId,
      revision: body.expectedRevision,
      commandId: command.commandId,
      actorId: command.origin.actorId,
      surface: command.origin.surface,
    });
    await this.inbox.append({ type: 'dispatched', commandId: command.commandId });
    this.dispatched.add(command.commandId);
    let cancelled = false;
    if (body.answer.kind === 'approval' && pending.request.content.kind === 'approval') {
      const option = pending.request.content.options.find(
        (x) => x.optionId === (body.answer as { optionId: string }).optionId
      )!;
      cancelled = option.decision === 'cancel';
      await this.adapter.respondToRequest(command.sessionId, body.requestId, option.decision);
    } else if (body.answer.kind === 'questions') {
      const answers: UserInputAnswers = {};
      for (const answer of body.answer.answers) {
        const values = answer.selectedOptionIds.map((id) => pending.options.get(id)!);
        if (answer.customText?.trim()) values.push(answer.customText.trim());
        const question =
          pending.request.content.kind === 'questions'
            ? pending.request.content.questions.find((q) => q.questionId === answer.questionId)!
            : null;
        answers[answer.questionId] = question?.multiSelect ? values : values[0];
      }
      await this.adapter.respondToUserInput(command.sessionId, body.requestId, answers);
    }
    await this.publish({
      type: 'request.settled',
      requestId: body.requestId,
      revision: body.expectedRevision + 1,
      outcome: cancelled ? 'cancelled' : 'answered',
      commandId: command.commandId,
      result: cancelled ? null : body.answer,
    });
    this.questions.delete(body.requestId);
  }

  private publishAll(bodies: HostBody[]): Promise<void> {
    return bodies.reduce((tail, body) => tail.then(() => this.publish(body)), Promise.resolve());
  }
  private publish(body: ServerEvent['body']): Promise<void> {
    const pending = this.publishing.then(async () => {
      const event: ServerEvent = {
        contractVersion: 1,
        eventId: randomUUID(),
        sessionId: this.config.session.sessionId,
        sequence: this.events.records.length + 1,
        occurredAt: new Date().toISOString(),
        body,
      };
      if (eventBytes(event) > 64 * 1024)
        throw new Error('PAYLOAD_TOO_LARGE: event exceeds 64 KiB.');
      serverEventSchema.parse(event);
      await this.events.append(event);
      this.replica.apply(event);
    });
    this.publishing = pending.catch(() => {});
    return pending;
  }
  private async fail(error: unknown): Promise<void> {
    if (this.fault) return;
    clearInterval(this.timer);
    this.fault = error instanceof Error ? error : new Error(String(error));
    this.config.session.status = 'error';
    try {
      await this.publish({ type: 'session.upsert', session: structuredClone(this.config.session) });
      await this.publish({
        type: 'notice',
        level: 'error',
        code: 'HOST_ERROR',
        message: this.fault.message,
      });
    } catch (persistenceError) {
      console.error('SDK host could not persist its failure:', String(persistenceError));
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.timer);
    if (this.adapter.hasSession(this.config.session.sessionId))
      await this.adapter.stopSession(this.config.session.sessionId);
    await this.serial;
    await this.eventSerial;
    await this.publishing;
    this.unsubscribe();
  }
}
