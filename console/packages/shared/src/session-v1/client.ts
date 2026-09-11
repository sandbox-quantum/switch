import { isDeepEqual } from '../deep-equal';
import type { Attachment, Command, ServerEvent, Snapshot } from './contract';
import { SessionReplica } from './replica';
import { commandStatusSchema, snapshotSchema } from './validation';

export type ClientCommand = Omit<Command, 'origin'>;
export type CommandStatus = Snapshot['commandStatuses'][number];
/** Transport methods must validate server JSON before returning typed receipts. */
export type AttachmentUpload = {
  attachmentId: string;
  name: string;
  mimeType: string;
  data: string;
};
export interface SessionTransport {
  uploadAttachment?(sessionId: string, file: AttachmentUpload): Promise<Attachment>;
  snapshot(sessionId: string, pageToken: string | null): Promise<unknown>;
  subscribe(
    sessionId: string,
    after: number,
    onEvent: (event: unknown) => void,
    onError: (error: Error) => void,
    onCursor: (sequence: number) => void
  ): () => void;
  submit(command: ClientCommand): Promise<CommandStatus>;
  commandStatus(sessionId: string, commandId: string): Promise<CommandStatus>;
}
export type ChatView = {
  snapshot: Snapshot | null;
  connected: boolean;
  error: string | null;
  notices: Extract<ServerEvent['body'], { type: 'notice' }>[];
};

/** Client transport disconnects preserve execution state and command identity. */
export class SessionChatClient {
  private replica: SessionReplica | null = null;
  private view: ChatView = { snapshot: null, connected: false, error: null, notices: [] };
  private off: (() => void) | null = null;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: ClientCommand | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly sessionId: string,
    private readonly transport: SessionTransport
  ) {}
  getSnapshot = (): ChatView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async connect(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const generation = ++this.generation;
    this.off?.();
    this.off = null;
    this.publish(false, null);
    try {
      const first = snapshotSchema.parse(await this.transport.snapshot(this.sessionId, null));
      if (first.session.sessionId !== this.sessionId)
        throw new Error('Snapshot belongs to another session.');
      const seen = new Set<string>();
      let next = first.nextPageToken;
      while (next !== null) {
        if (seen.has(next)) throw new Error('Snapshot pagination repeated a page token.');
        seen.add(next);
        const page = snapshotSchema.parse(await this.transport.snapshot(this.sessionId, next));
        if (
          page.throughSequence !== first.throughSequence ||
          page.session.sessionId !== first.session.sessionId ||
          page.session.epoch !== first.session.epoch
        )
          throw new Error('Snapshot pages changed version.');
        first.turns.push(...page.turns);
        first.items.push(...page.items);
        first.requests.push(...page.requests);
        first.commandStatuses.push(...page.commandStatuses);
        next = page.nextPageToken;
      }
      first.nextPageToken = null;
      if (generation !== this.generation) return;
      this.replica = new SessionReplica(first);
      this.publish(true, null);
      const off = this.transport.subscribe(
        this.sessionId,
        first.throughSequence,
        (event) => {
          if (generation !== this.generation) return;
          try {
            this.replica?.apply(event);
            this.publish(true, null);
          } catch (error) {
            this.disconnect(generation, String(error));
          }
        },
        (error) => {
          this.disconnect(generation, error.message);
        },
        (sequence) => {
          if (generation !== this.generation) return;
          try {
            this.replica?.advanceCursor(sequence);
            this.publish(true, null);
          } catch (error) {
            this.disconnect(generation, String(error));
          }
        }
      );
      if (generation === this.generation) this.off = off;
      else off();
    } catch (error) {
      if (generation === this.generation) {
        this.publish(false, String(error));
        this.scheduleReconnect();
      }
    }
  }

  async uploadAttachment(file: AttachmentUpload): Promise<Attachment> {
    if (!this.transport.uploadAttachment) throw new Error('Attachment upload is unavailable.');
    return this.transport.uploadAttachment(this.sessionId, file);
  }

  async send(
    text: string,
    commandId: string,
    attachments: Attachment[] = []
  ): Promise<CommandStatus> {
    const snapshot = this.replica?.snapshot();
    if (!snapshot || !this.view.connected || snapshot.session.connectivity !== 'online')
      throw new Error('HOST_OFFLINE: reconnect before sending.');
    if (snapshot.session.status !== 'ready' && snapshot.session.status !== 'running')
      throw new Error('Session is not ready for messages.');
    if (
      this.pending &&
      (this.pending.commandId !== commandId ||
        this.pending.body.type !== 'message.send' ||
        this.pending.body.text !== text ||
        !isDeepEqual(this.pending.body.attachments, attachments))
    )
      throw new Error('Resolve the previous message before sending another.');
    const command: ClientCommand = this.pending ?? {
      contractVersion: 1,
      commandId,
      sessionId: this.sessionId,
      epoch: snapshot.session.epoch,
      body: {
        type: 'message.send',
        text,
        attachments,
        delivery: 'queue',
      },
    };
    if (command.epoch !== snapshot.session.epoch)
      throw new Error('STALE_EPOCH: the previous message needs reconciliation.');
    this.pending = command;
    // Keep this command on uncertain transport failure; retry uses the same ID and body.
    const status = commandStatusSchema.parse(await this.transport.submit(command));
    this.acceptReceipt(status, commandId);
    return status;
  }

  async execute(body: Command['body'], commandId: string): Promise<CommandStatus> {
    const session = this.replica?.snapshot().session;
    if (!session || !this.view.connected || session.connectivity !== 'online')
      throw new Error('HOST_OFFLINE: reconnect before sending.');
    if (
      this.pending &&
      (this.pending.commandId !== commandId ||
        JSON.stringify(this.pending.body) !== JSON.stringify(body))
    )
      throw new Error('Resolve the previous command before sending another.');
    const command = this.pending ?? {
      contractVersion: 1 as const,
      commandId,
      sessionId: this.sessionId,
      epoch: session.epoch,
      body,
    };
    if (command.epoch !== session.epoch)
      throw new Error('STALE_EPOCH: reconcile the previous command.');
    this.pending = command;
    const status = commandStatusSchema.parse(await this.transport.submit(command));
    this.acceptReceipt(status, commandId);
    return status;
  }

  hasPendingCommand(): boolean {
    return this.pending !== null;
  }

  async reconcile(): Promise<CommandStatus> {
    if (!this.pending) throw new Error('No uncertain command.');
    const id = this.pending.commandId;
    const status = commandStatusSchema.parse(
      await this.transport.commandStatus(this.sessionId, id)
    );
    this.acceptReceipt(status, id);
    return status;
  }

  hasUnknownCommand(): boolean {
    return Boolean(
      this.pending &&
      this.view.snapshot?.commandStatuses.some(
        (status) => status.commandId === this.pending?.commandId && status.status === 'unknown'
      )
    );
  }

  async acknowledgeUnknown(): Promise<void> {
    if (!this.pending) throw new Error('No uncertain command.');
    const id = this.pending.commandId;
    const status = commandStatusSchema.parse(
      await this.transport.commandStatus(this.sessionId, id)
    );
    if (status.commandId !== id || status.status !== 'unknown')
      throw new Error('Check command status before acknowledging an unknown outcome.');
    this.replica?.recordReceipt(status);
    this.pending = null;
    this.publish(this.view.connected, null);
  }

  dispose(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    ++this.generation;
    this.off?.();
    this.off = null;
    this.publish(false, null);
  }

  private acceptReceipt(status: CommandStatus, commandId: string): void {
    if (status.commandId !== commandId) throw new Error('Command receipt identity mismatch.');
    if (status.status === 'unknown') {
      this.replica?.recordReceipt(status);
      this.publish(this.view.connected, null);
      throw new Error('Command outcome is unknown. It will not be resent automatically.');
    }
    if (status.status === 'rejected') {
      this.pending = null;
      throw new Error(status.message ?? status.code ?? 'Message rejected.');
    }
    this.pending = null;
    this.replica?.recordReceipt(status);
    this.publish(this.view.connected, null);
  }

  private disconnect(generation: number, error: string): void {
    if (generation !== this.generation) return;
    ++this.generation;
    this.off?.();
    this.off = null;
    this.publish(false, error);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 1000);
  }

  private publish(connected: boolean, error: string | null): void {
    this.view = {
      snapshot: this.replica?.snapshot() ?? null,
      connected,
      error,
      notices: [...(this.replica?.notices ?? [])],
    };
    for (const listener of this.listeners) listener();
  }
}
