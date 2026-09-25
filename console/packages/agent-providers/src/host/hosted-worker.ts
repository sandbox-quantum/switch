import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  WORKER_CAPABILITY_OBSOLETE,
  WorkerCallError,
  type WorkerFrameName,
  type WorkerIdentity,
} from '@sandboxaq/switch-agent-runtime';
import { z } from 'zod';
import { ControlError } from './attachment-transfers';
import {
  type ControlContext,
  type ControlMessage,
  controlMessageSchema,
  ControlPeer,
  type ControlPush,
  handleControlMessage,
} from './control';
import { WorkerObsoleteError } from './exit-codes';
import { Journal } from './journal';
import { sharedSessionRoot } from './launch';
import {
  SessionHostFailedError,
  SessionUnavailableError,
  type SessionLinks,
} from './session-channel';

/**
 * The hosted half of a watcher: what an agent's cloud worker does on top of
 * routing room messages. It answers Console requests Switch relays to it,
 * reports whether it is idle so the launch can sleep, claims the operations
 * Switch rings it for, applies provider credentials, posts the room notices it
 * owes and acknowledges mailbox deliveries. Everything it must not lose across
 * a restart is journaled beside `assignments.jsonl`.
 */

/** How long a mutating relay may stay unresolved before the watcher tries to close it. */
export const RELAY_STALE_MS = 5 * 60_000;
/** How often a hung host is asked again for a busy barrier. */
const BARRIER_RETRY_MS = 60_000;
const BARRIER_TIMEOUT_MS = 10_000;
/** A mutating Console relay keeps the worker busy for this long. */
export const CONSOLE_RECENT_MS = 10 * 60_000;
/** How long a session whose host failed holds the worker awake after its notice. */
export const FAILED_HOLD_MS = 15 * 60_000;
const PUSH_BATCH_MS = 250;
const PUSH_BATCH_BYTES = 64 * 1024;
const ACKS_PER_CALL = 200;
/** A page's slice; its base64 fits a 1 MiB relay reply. */
export const PAGE_BYTES = 768 * 1024;
export const PAGE_IDLE_MS = 120_000;
const MAX_PINS = 4;
const MAX_PINNED_BYTES = 64 * 1024 * 1024;
const REPLY_ERROR_CHARS = 2048;

const attachedSchema = z.object({
  launch_revision: z.number().int(),
  limits: z.object({ sessions_per_agent: z.number().int().positive() }),
  idle: z.object({ report_every_s: z.number().positive(), fresh_for_s: z.number().positive() }),
  credential_revision: z.string().nullable(),
  queued_operations: z.array(z.string().min(1)),
  relay_fence: z.number().int().nonnegative(),
  cancelled: z.array(
    z.object({
      room_id: z.string().min(1),
      message_id: z.string().min(1),
      reason: z.enum(['stopped', 'expired']),
    })
  ),
});
const relaySchema = z.object({
  id: z.string().min(1),
  deadline_ms: z.number(),
  relay_seq: z.number().int().positive().nullable(),
  message: z.unknown(),
});
const wakeEntrySchema = z.object({
  room_id: z.string().min(1),
  message_id: z.string().min(1),
  thread_id: z.string().nullable(),
  event: z.unknown(),
});
const deliverySchema = z.object({ room_id: z.string().min(1), message_id: z.string().min(1) });
const operationSummarySchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  action: z.enum(['start', 'restart']),
});
const idleAnswerSchema = z.object({
  queued_operations: z.array(z.string().min(1)),
  credential_revision: z.string().nullable(),
});
const pushAnswerSchema = z.object({ unsubscribe: z.array(z.string()) }).partial();

export type WakeEntry = z.infer<typeof wakeEntrySchema>;
export type HostedOperation = { id: string; sessionId: string; action: 'start' | 'restart' };
export type CancelReason = 'stopped' | 'expired';
export type NoticeReason =
  | 'startup'
  | 'delivery'
  | 'conversation'
  | 'capacity'
  | 'auto_start_off'
  | 'stopped'
  | 'expired'
  | 'cancelled'
  | 'revoked'
  | 'upgrade';
export type Notice = {
  roomId: string;
  messageId: string;
  threadId: string | null;
  reason: NoticeReason;
};
export type MailboxOutcome =
  | 'journaled'
  | 'admitted'
  | 'duplicate'
  | 'refused'
  | 'held'
  | 'cancelled';
export type MailboxAck = {
  roomId: string;
  messageId: string;
  outcome: MailboxOutcome;
  reason?: string;
};
export type IdleReason = { kind: string; session_id: string | null; count: number };
export type SessionCounts = {
  total: number;
  live: number;
  parked: number;
  failed: number;
  /** Live, starting or parked, and not stopped: what the session limit counts. */
  active: number;
};

/** An operation the watcher will not run, with the reason Switch records as its failure. */
export class OperationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationRefusedError';
  }
}

/** Where the watcher keeps its unconfirmed mailbox acks: `assignments.jsonl`. */
export type AckStore = {
  recordAck(ack: MailboxAck): Promise<void>;
  unconfirmedAcks(): MailboxAck[];
  confirmAcks(acks: MailboxAck[]): Promise<void>;
};

/** What the watcher lends the hosted worker. */
export type HostedPort = {
  /** Runs `work` in the watcher's serial section, behind every routing decision before it. */
  serial: <T>(work: () => Promise<T>) => Promise<T>;
  /** Why the watcher itself is busy: messages it still has to hand a session. */
  reasons: () => IdleReason[];
  sessions: () => Promise<SessionCounts>;
  /** A mailbox row, journaled and routed like a live event. Called in `serial`. */
  wake: (entry: WakeEntry) => Promise<void>;
  /** Settle deliveries Switch cancelled. Called in `serial`. */
  cancel: (entries: { roomId: string; messageId: string; reason: CancelReason }[]) => Promise<void>;
  /** Start or restart a session; an `OperationRefusedError` is a failed operation. Called in `serial`. */
  operate: (operation: HostedOperation, limit: number) => Promise<void>;
  /** Stop every host: the provider was disconnected. */
  revoke: () => Promise<void>;
  /** Restart the idle host at this root so it starts under the current credentials. */
  restart: (root: string) => Promise<void>;
  acks: AckStore;
  fail: (error: Error) => void;
};

/** What the hosted worker needs of the stream it rides on. */
export type WorkerStream = {
  workerCall: (path: string, body: Record<string, unknown>) => Promise<unknown>;
};

/** The provider credential as Switch holds it now, and how to put it in place. */
export type HostedCredentials = {
  fetch: () => Promise<{ revoked: boolean; revision: string | null; apply: () => Promise<void> }>;
};

const RESOLUTIONS = [
  'taken',
  'refused',
  'interrupted',
  'not_delivered',
  'abandoned',
  'barrier',
] as const;
export type RelayResolution = (typeof RESOLUTIONS)[number];

const relayRecordSchema = z.union([
  z.strictObject({
    received: z.strictObject({ seq: z.number().int().positive(), id: z.string().min(1) }),
  }),
  z.strictObject({
    resolved: z.strictObject({ seq: z.number().int().positive(), how: z.enum(RESOLUTIONS) }),
  }),
  /** Every number at or below it that was never received is `not_delivered`. */
  z.strictObject({ fence: z.number().int().nonnegative() }),
]);
type RelayRecord = z.infer<typeof relayRecordSchema>;

/**
 * `relays.jsonl`: each mutating relay's number as it is received and as it is
 * resolved, and the reattach fences. `through` is the contiguous resolved
 * watermark the idle report carries.
 */
export class RelayJournal {
  private readonly receivedIds = new Map<number, string>();
  private readonly resolvedSeqs = new Set<number>();
  private fenced = 0;
  private mark = 0;

  private constructor(private readonly journal: Journal<RelayRecord>) {
    for (const record of journal.records) this.apply(record);
  }

  /** Opens the journal; what the last process received and never resolved is `interrupted`. */
  static async open(root: string): Promise<RelayJournal> {
    const relays = new RelayJournal(
      await Journal.load(join(root, 'relays.jsonl'), (value) => relayRecordSchema.parse(value))
    );
    for (const seq of relays.unresolved()) await relays.resolve(seq, 'interrupted');
    return relays;
  }

  private apply(record: RelayRecord): void {
    if ('received' in record) this.receivedIds.set(record.received.seq, record.received.id);
    else if ('resolved' in record) this.resolvedSeqs.add(record.resolved.seq);
    else this.fenced = Math.max(this.fenced, record.fence);
  }

  private async append(record: RelayRecord): Promise<void> {
    await this.journal.append(record);
    this.apply(record);
  }

  unresolved(): number[] {
    return [...this.receivedIds.keys()].filter((seq) => !this.resolvedSeqs.has(seq));
  }

  isResolved(seq: number): boolean {
    return this.resolvedSeqs.has(seq);
  }

  async receive(seq: number, id: string): Promise<void> {
    if (this.receivedIds.has(seq)) return;
    await this.append({ received: { seq, id } });
  }

  async resolve(seq: number, how: RelayResolution): Promise<void> {
    if (this.resolvedSeqs.has(seq)) return;
    await this.append({ resolved: { seq, how } });
  }

  async fence(relaySeq: number): Promise<void> {
    if (relaySeq <= this.fenced) return;
    await this.append({ fence: relaySeq });
  }

  /** The largest N with every number up to N resolved, a fenced one never received counting as resolved. */
  get through(): number {
    let at = this.mark;
    for (;;) {
      const next = at + 1;
      if (this.resolvedSeqs.has(next) || (!this.receivedIds.has(next) && next <= this.fenced))
        at = next;
      else break;
    }
    this.mark = at;
    return at;
  }
}

type Pin = {
  bytes: number;
  pageCount: number;
  touchedAt: number;
  sessionId: string | null;
  epoch: string | null;
};

const pinnedSnapshotSchema = z.object({
  throughSequence: z.number().int(),
  session: z.object({ epoch: z.string() }),
});

/**
 * Relayed answers too large for one reply, serialized once and pinned under
 * `relay-pages/` so every page is a slice of the same bytes.
 */
export class RelayPages {
  private readonly pins = new Map<string, Pin>();

  constructor(
    private readonly root: string,
    private readonly epochOf: (sessionId: string) => string | null
  ) {}

  private get directory(): string {
    return join(this.root, 'relay-pages');
  }

  async clear(): Promise<void> {
    this.pins.clear();
    await rm(this.directory, { recursive: true, force: true });
  }

  private async drop(snapshotId: string): Promise<void> {
    this.pins.delete(snapshotId);
    await rm(join(this.directory, snapshotId), { force: true });
  }

  async sweep(now: number): Promise<void> {
    for (const [snapshotId, pin] of this.pins)
      if (now - pin.touchedAt >= PAGE_IDLE_MS) await this.drop(snapshotId);
  }

  /** The first page of `value`; the rest are pinned for `page`. */
  async pin(value: unknown, sessionId: string | null): Promise<unknown> {
    await this.sweep(Date.now());
    const data = Buffer.from(JSON.stringify(value ?? null));
    const snapshot = pinnedSnapshotSchema.safeParse(value);
    const epoch = snapshot.success ? snapshot.data.session.epoch : null;
    const pageCount = Math.max(1, Math.ceil(data.byteLength / PAGE_BYTES));
    const snapshotId = randomUUID();
    if (pageCount > 1) {
      const pinned = [...this.pins.values()].reduce((total, pin) => total + pin.bytes, 0);
      if (this.pins.size >= MAX_PINS || pinned + data.byteLength > MAX_PINNED_BYTES)
        throw new ControlError(
          'snapshot_busy',
          'Too many paged answers are pinned; retry shortly.'
        );
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(join(this.directory, snapshotId), data, { mode: 0o600 });
      this.pins.set(snapshotId, {
        bytes: data.byteLength,
        pageCount,
        touchedAt: Date.now(),
        sessionId,
        epoch,
      });
    }
    return {
      snapshotId,
      epoch,
      throughSequence: snapshot.success ? snapshot.data.throughSequence : null,
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      pageCount,
      page: { index: 0, data: data.subarray(0, PAGE_BYTES).toString('base64') },
    };
  }

  async page(snapshotId: string, index: number): Promise<unknown> {
    await this.sweep(Date.now());
    const pin = this.pins.get(snapshotId);
    if (!pin)
      throw new ControlError('snapshot_expired', 'That paged answer has expired; start over.');
    if (pin.sessionId !== null && pin.epoch !== null) {
      const epoch = this.epochOf(pin.sessionId);
      if (epoch !== null && epoch !== pin.epoch) {
        await this.drop(snapshotId);
        throw new ControlError(
          'snapshot_superseded',
          'The session was reset since this answer was taken; start over.'
        );
      }
    }
    if (index >= pin.pageCount)
      throw new ControlError('invalid_page', `That answer has ${pin.pageCount} page(s).`);
    const length = Math.min(PAGE_BYTES, pin.bytes - index * PAGE_BYTES);
    const buffer = Buffer.alloc(length);
    const file = await open(join(this.directory, snapshotId), 'r');
    try {
      await file.read(buffer, 0, length, index * PAGE_BYTES);
    } finally {
      await file.close();
    }
    pin.touchedAt = Date.now();
    return { snapshotId, page: { index, data: buffer.toString('base64') } };
  }
}

const operationRecordSchema = z.union([
  z.strictObject({
    claimed: z.strictObject({
      id: z.string().min(1),
      sessionId: z.string().min(1),
      action: z.enum(['start', 'restart']),
    }),
  }),
  z.strictObject({
    outcome: z.strictObject({
      id: z.string().min(1),
      state: z.enum(['applied', 'failed', 'unknown']),
      error: z.string().nullable(),
    }),
  }),
  z.strictObject({ posted: z.string().min(1) }),
]);
type OperationRecord = z.infer<typeof operationRecordSchema>;
type OperationOutcome = {
  id: string;
  state: 'applied' | 'failed' | 'unknown';
  error: string | null;
};

const noticeRecordSchema = z.union([
  z.strictObject({
    notice: z.strictObject({
      roomId: z.string().min(1),
      messageId: z.string().min(1),
      threadId: z.string().nullable(),
      reason: z.enum([
        'startup',
        'delivery',
        'conversation',
        'capacity',
        'auto_start_off',
        'stopped',
        'expired',
        'cancelled',
        'revoked',
        'upgrade',
      ]),
    }),
  }),
  z.strictObject({ sent: z.string().min(1) }),
]);
type NoticeRecord = z.infer<typeof noticeRecordSchema>;

const noticeKey = (notice: Notice): string =>
  JSON.stringify([notice.roomId, notice.messageId, notice.reason]);

type Inflight = {
  id: string;
  seq: number;
  sessionId: string | null;
  root: string | null;
  receivedAt: number;
  dispatched: boolean;
  cancelled: boolean;
  warned: boolean;
  nextBarrierAt: number;
};

/** A handler cancelled before it reached the host. */
class RelayAbandonedError extends Error {
  constructor() {
    super('The relay was cancelled before it reached the session host.');
    this.name = 'RelayAbandonedError';
  }
}

function sessionOf(message: ControlMessage): string | null {
  if ('sessionId' in message) return message.sessionId;
  if ('place' in message) return message.place.sessionId;
  if ('forget' in message) return message.forget;
  if ('attachment' in message) return message.attachment.sessionId;
  if ('journal' in message) return message.journal;
  return null;
}

function isPaged(message: ControlMessage): boolean {
  return (
    ('request' in message && message.request.type === 'snapshot') ||
    'journal' in message ||
    'list' in message
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One per watcher process. `open` reads its journals; `bind` attaches it to
 * the watcher's stream and serial section for as long as the watcher runs.
 */
export class HostedWorker {
  private relays!: RelayJournal;
  private operations!: Journal<OperationRecord>;
  private notices!: Journal<NoticeRecord>;
  private readonly pages: RelayPages;
  private readonly peer: ControlPeer;
  private readonly inflight = new Map<string, Inflight>();
  private readonly hungHosts = new Set<string>();
  private readonly claiming = new Set<string>();
  private readonly staleHosts = new Set<string>();
  private stream: WorkerStream | null = null;
  private port: HostedPort | null = null;
  private attachedState: z.infer<typeof attachedSchema> | null = null;
  private lastMutatingAt = Number.NEGATIVE_INFINITY;
  private reportSeq = 0;
  private lastReport: { key: string; at: number } | null = null;
  private reporting: Promise<void> = Promise.resolve();
  private reportSoon: NodeJS.Timeout | null = null;
  private reportEvery: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private pushSeqs = new Map<string, number>();
  private pushQueue: Record<string, unknown>[] = [];
  private pushBytes = 0;
  private pushTimer: NodeJS.Timeout | null = null;
  private pushing: Promise<void> = Promise.resolve();
  private acking: Promise<void> = Promise.resolve();
  private credentialState: { revision: string | null; revoked: boolean } | null = null;
  private fetchingCredential: Promise<void> | null = null;
  /** Set once the first `worker_attached` has been reconciled: the watcher may admit from its journal. */
  reconciled = false;

  constructor(
    private readonly root: string,
    readonly identity: WorkerIdentity,
    private readonly context: ControlContext,
    private readonly credentials: HostedCredentials
  ) {
    this.pages = new RelayPages(root, (sessionId) => this.epochOf(sessionId));
    this.peer = new ControlPeer((push) => this.enqueuePush(push));
  }

  private get links(): SessionLinks {
    return this.context.links;
  }

  private get agentId(): string {
    return this.context.agentId;
  }

  async open(): Promise<void> {
    this.relays = await RelayJournal.open(this.root);
    this.operations = await Journal.load(join(this.root, 'operations.jsonl'), (value) =>
      operationRecordSchema.parse(value)
    );
    this.notices = await Journal.load(join(this.root, 'notices.jsonl'), (value) =>
      noticeRecordSchema.parse(value)
    );
    for (const claimed of this.claimedWithoutOutcome())
      await this.operations.append({
        outcome: {
          id: claimed,
          state: 'unknown',
          error:
            'The worker restarted before it could confirm the operation. Inspect the session before retrying.',
        },
      });
    await this.pages.clear();
  }

  /** The session limit Switch set, or null before the worker has attached. */
  get limit(): number | null {
    return this.attachedState?.limits.sessions_per_agent ?? null;
  }

  /** Whether the owner's provider connection is gone: no session may start. */
  get revoked(): boolean {
    return this.credentialState?.revoked === true;
  }

  bind(stream: WorkerStream, port: HostedPort): () => void {
    this.stream = stream;
    this.port = port;
    const offBusy = this.links.onBusy(() => {
      this.restartStale();
      this.changed();
    });
    const offExit = this.links.onExit((root) => {
      this.hungHosts.delete(root);
      this.staleHosts.delete(root);
      for (const relay of this.inflight.values())
        if (relay.root === root && relay.dispatched) void this.settle(relay, 'interrupted');
    });
    this.sweeper = setInterval(() => {
      void this.sweep(Date.now()).catch((error: unknown) => this.background(error, 'sweep'));
    }, 60_000);
    this.sweeper.unref();
    return () => {
      offBusy();
      offExit();
      this.peer.close();
      for (const timer of [this.sweeper, this.reportEvery, this.reportSoon, this.pushTimer])
        if (timer) clearTimeout(timer);
      this.sweeper = this.reportEvery = this.reportSoon = this.pushTimer = null;
      this.stream = null;
      this.port = null;
    };
  }

  private call(path: string, body: Record<string, unknown>): Promise<unknown> {
    if (!this.stream) throw new Error('The hosted worker is not bound to a stream.');
    return this.stream.workerCall(path, body);
  }

  /** Logs a background failure, and stops the worker for good on an obsolete capability. */
  private background(error: unknown, what: string): void {
    if (error instanceof WorkerCallError && error.code === WORKER_CAPABILITY_OBSOLETE) {
      this.port?.fail(new WorkerObsoleteError(error.message));
      return;
    }
    console.warn(`Hosted worker ${what} failed: ${describe(error)}`);
  }

  /** One protocol-7 frame, in the order the stream delivered it. */
  async frame(name: WorkerFrameName, data: Record<string, unknown>): Promise<void> {
    const port = this.port;
    if (!port) throw new Error('The hosted worker received a frame before it was bound.');
    switch (name) {
      case 'worker_attached':
        return this.attach(attachedSchema.parse(data));
      case 'relay':
        return this.relay(relaySchema.parse(data));
      case 'relay_cancel': {
        const { id } = z.object({ id: z.string().min(1) }).parse(data);
        const relay = this.inflight.get(id);
        if (relay && !relay.dispatched) {
          relay.cancelled = true;
          await this.settle(relay, 'abandoned');
        }
        return;
      }
      case 'wake': {
        const { entries } = z.object({ entries: z.array(wakeEntrySchema).max(50) }).parse(data);
        for (const entry of entries) await port.serial(() => port.wake(entry));
        this.changed();
        return;
      }
      case 'mailbox_cancel': {
        const { entries } = z.object({ entries: z.array(deliverySchema) }).parse(data);
        await port.serial(() =>
          port.cancel(
            entries.map((entry) => ({
              roomId: entry.room_id,
              messageId: entry.message_id,
              reason: 'stopped',
            }))
          )
        );
        return;
      }
      case 'operation': {
        const { id } = z.object({ id: z.string().min(1) }).parse(data);
        void this.claim(id);
        return;
      }
      case 'credential': {
        const { revision } = z.object({ revision: z.string().nullable() }).parse(data);
        if (revision !== this.credentialState?.revision || revision === null)
          void this.refreshCredential();
        return;
      }
    }
  }

  private async attach(attached: z.infer<typeof attachedSchema>): Promise<void> {
    const port = this.port!;
    this.attachedState = attached;
    await this.pages.clear();
    await this.context.transfers.clear();
    this.pushSeqs = new Map();
    this.pushQueue = [];
    this.pushBytes = 0;
    await this.relays.fence(attached.relay_fence);
    await port.serial(() =>
      port.cancel(
        attached.cancelled.map((entry) => ({
          roomId: entry.room_id,
          messageId: entry.message_id,
          reason: entry.reason,
        }))
      )
    );
    this.reconciled = true;
    if (this.reportEvery) clearInterval(this.reportEvery);
    this.reportEvery = setInterval(() => this.report(true), attached.idle.report_every_s * 1000);
    this.reportEvery.unref();
    this.lastReport = null;
    void this.catchUp(attached.queued_operations);
  }

  /** What a reattach owes Switch: claims, the credential, and every unconfirmed notice, result and ack. */
  private async catchUp(queued: string[]): Promise<void> {
    await this.refreshCredential();
    for (const id of queued) await this.claim(id);
    await this.postResults();
    await this.sendNotices();
    await this.flushAcks();
    this.report(true);
  }

  private async relay(frame: z.infer<typeof relaySchema>): Promise<void> {
    const parsed = controlMessageSchema.safeParse(frame.message);
    const message = parsed.success ? (parsed.data as ControlMessage) : null;
    const sessionId = message ? sessionOf(message) : null;
    let relay: Inflight | null = null;
    if (frame.relay_seq !== null) {
      await this.relays.receive(frame.relay_seq, frame.id);
      this.lastMutatingAt = Date.now();
      relay = {
        id: frame.id,
        seq: frame.relay_seq,
        sessionId,
        root: null,
        receivedAt: Date.now(),
        dispatched: false,
        cancelled: false,
        warned: false,
        nextBarrierAt: 0,
      };
      this.inflight.set(frame.id, relay);
      this.changed();
    }
    void this.answer(frame.id, message, relay);
  }

  private async answer(
    id: string,
    message: ControlMessage | null,
    relay: Inflight | null
  ): Promise<void> {
    let reply: Record<string, unknown>;
    try {
      const value = await this.handle(message, relay);
      reply = { ok: true, value: value ?? null };
      if (relay) await this.settle(relay, 'taken');
    } catch (error) {
      reply = {
        ok: false,
        error: {
          code: this.codeOf(error),
          message: describe(error).slice(0, REPLY_ERROR_CHARS),
        },
      };
      if (relay) await this.settleFailure(relay, error);
    }
    try {
      await this.call(`/agents/${this.agentId}/connection/relay/${id}`, reply);
    } catch (error) {
      if (error instanceof WorkerCallError && (error.status === 404 || error.status === 409))
        return;
      this.background(error, `reply to relay ${id}`);
    }
  }

  private async handle(message: ControlMessage | null, relay: Inflight | null): Promise<unknown> {
    if (!message) throw new ControlError('refused_message', 'The relayed message is unreadable.');
    if (
      'ensure' in message ||
      ('request' in message && ['room', 'approvals'].includes(message.request.type))
    )
      throw new ControlError('refused_message', 'Only the watcher sends that message.');
    if ('page' in message) return this.pages.page(message.page.snapshotId, message.page.index);
    if (relay && 'request' in message) relay.root = sharedSessionRoot(message.sessionId);
    else if (relay) relay.dispatched = true;
    const value = await handleControlMessage(this.context, this.peer, message, () => {
      if (!relay) return;
      if (relay.cancelled) throw new RelayAbandonedError();
      relay.dispatched = true;
    });
    return isPaged(message) ? this.pages.pin(value, sessionOf(message)) : value;
  }

  private codeOf(error: unknown): string {
    if (error instanceof ControlError) return error.code;
    if (error instanceof SessionHostFailedError) return 'session_failed';
    if (error instanceof SessionUnavailableError) return 'session_unavailable';
    if (error instanceof RelayAbandonedError) return 'relay_abandoned';
    return 'failed';
  }

  private async settleFailure(relay: Inflight, error: unknown): Promise<void> {
    if (error instanceof RelayAbandonedError) return this.settle(relay, 'abandoned');
    if (!relay.dispatched) return this.settle(relay, 'refused');
    if (error instanceof SessionHostFailedError) return this.settle(relay, 'interrupted');
    if (error instanceof SessionUnavailableError) {
      // Sent and not answered: the host may still act on it, unless it is gone.
      if (relay.root && this.links.ready(relay.root)) return;
      return this.settle(relay, 'interrupted');
    }
    return this.settle(relay, 'refused');
  }

  private async settle(relay: Inflight, how: RelayResolution): Promise<void> {
    this.inflight.delete(relay.id);
    await this.relays.resolve(relay.seq, how);
    this.changed();
  }

  /** Closes relays unresolved past `RELAY_STALE_MS` where that can be done safely. */
  async sweep(now: number): Promise<void> {
    await this.pages.sweep(now);
    for (const relay of [...this.inflight.values()]) {
      if (now - relay.receivedAt < RELAY_STALE_MS) continue;
      if (!relay.warned) {
        relay.warned = true;
        console.warn(
          `Console relay ${relay.id} (#${relay.seq}) has been unresolved for five minutes; closing it.`
        );
      }
      if (!relay.dispatched) {
        relay.cancelled = true;
        await this.settle(relay, 'abandoned');
        continue;
      }
      const root = relay.root;
      if (!root || !this.links.ready(root)) {
        await this.settle(relay, 'interrupted');
        continue;
      }
      if (now < relay.nextBarrierAt) continue;
      relay.nextBarrierAt = now + BARRIER_RETRY_MS;
      try {
        await this.links.barrier(root, BARRIER_TIMEOUT_MS);
        this.hungHosts.delete(root);
        await this.settle(relay, 'barrier');
      } catch (error) {
        if (!this.links.ready(root)) {
          this.hungHosts.delete(root);
          await this.settle(relay, 'interrupted');
          continue;
        }
        if (!this.hungHosts.has(root))
          console.warn(
            `The session host at ${root} did not answer a busy barrier (${describe(error)}); it counts as busy until it does or it stops.`
          );
        this.hungHosts.add(root);
        this.changed();
      }
    }
  }

  private enqueuePush(push: ControlPush): void {
    const subscription = 'health' in push ? 'health' : push.sessionId;
    const seq = (this.pushSeqs.get(subscription) ?? 0) + 1;
    this.pushSeqs.set(subscription, seq);
    const entry: Record<string, unknown> =
      'health' in push
        ? { subscription, seq, health: push.health }
        : 'event' in push
          ? { subscription, seq, event: push.event }
          : { subscription, seq, failure: push.failure };
    this.pushQueue.push(entry);
    this.pushBytes += JSON.stringify(entry).length;
    if (this.pushBytes >= PUSH_BATCH_BYTES) this.flushPushes();
    else this.pushTimer ??= setTimeout(() => this.flushPushes(), PUSH_BATCH_MS);
  }

  private flushPushes(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    const pushes = this.pushQueue;
    this.pushQueue = [];
    this.pushBytes = 0;
    if (!pushes.length) return;
    this.pushing = this.pushing.then(async () => {
      try {
        const answer = pushAnswerSchema.parse(
          await this.call(`/agents/${this.agentId}/connection/relay/push`, { pushes })
        );
        for (const subscription of answer.unsubscribe ?? []) {
          if (subscription === 'health') {
            this.peer.unwatchHealth?.();
            this.peer.unwatchHealth = null;
          } else {
            this.peer.subscriptions.get(subscription)?.();
            this.peer.subscriptions.delete(subscription);
          }
        }
      } catch (error) {
        // Switch sees the gap in `seq` and has its views resynchronize.
        this.background(error, `push of ${pushes.length} live update(s)`);
      }
    });
  }

  /** Something that goes into the idle report may have changed. */
  changed(): void {
    if (!this.attachedState || this.reportSoon) return;
    this.reportSoon = setTimeout(() => {
      this.reportSoon = null;
      this.report(false);
    }, 100);
    this.reportSoon.unref();
  }

  private reasons(port: HostedPort, now: number): IdleReason[] {
    const reasons = new Map<string, IdleReason>();
    const add = (kind: string, sessionId: string | null, count: number) => {
      const key = JSON.stringify([kind, sessionId]);
      const existing = reasons.get(key);
      if (existing) existing.count += count;
      else reasons.set(key, { kind, session_id: sessionId, count });
    };
    for (const root of this.links.live()) {
      const sessionId = this.links.identity(root)?.sessionId ?? null;
      const busy = this.links.busy(root);
      if (busy === null || this.hungHosts.has(root)) add('host_unknown', sessionId, 1);
      else for (const reason of busy.reasons) add(reason.kind, sessionId, reason.count);
    }
    for (const reason of port.reasons()) add(reason.kind, reason.session_id, reason.count);
    for (const relay of this.inflight.values()) add('relay_inflight', relay.sessionId, 1);
    for (const claimed of this.claimedWithoutOutcome()) {
      const record = this.operations.records.find(
        (entry) => 'claimed' in entry && entry.claimed.id === claimed
      );
      add('operation_claimed', record && 'claimed' in record ? record.claimed.sessionId : null, 1);
    }
    if (now - this.lastMutatingAt < CONSOLE_RECENT_MS) add('console_recent', null, 1);
    return [...reasons.values()];
  }

  /** Sends the idle report if it changed, or regardless when `force`d; one at a time. */
  report(force: boolean): void {
    this.reporting = this.reporting.then(async () => {
      const port = this.port;
      if (!port || !this.attachedState) return;
      try {
        const now = Date.now();
        const reasons = this.reasons(port, now);
        const { active: _active, ...sessions } = await port.sessions();
        const body = {
          relays_through: this.relays.through,
          busy: reasons.length > 0,
          reasons,
          sessions,
        };
        const key = JSON.stringify(body);
        if (!force && this.lastReport?.key === key) return;
        this.reportSeq += 1;
        const answer = idleAnswerSchema.parse(
          await this.call(`/agents/${this.agentId}/connection/idle`, {
            report_seq: this.reportSeq,
            ...body,
          })
        );
        this.lastReport = { key, at: now };
        for (const id of answer.queued_operations) void this.claim(id);
        if (answer.credential_revision !== (this.credentialState?.revision ?? null))
          void this.refreshCredential();
        void this.flushAcks();
      } catch (error) {
        this.background(error, 'idle report');
      }
    });
  }

  private claimedWithoutOutcome(): string[] {
    const finished = new Set(
      this.operations.records.flatMap((record) => ('outcome' in record ? [record.outcome.id] : []))
    );
    return this.operations.records.flatMap((record) =>
      'claimed' in record && !finished.has(record.claimed.id) ? [record.claimed.id] : []
    );
  }

  /** Claims the operation Switch rang for and runs it, unless it is already this worker's. */
  async claim(id: string): Promise<void> {
    const port = this.port;
    if (!port) return;
    if (this.claiming.has(id)) return;
    if (this.operations.records.some((record) => 'claimed' in record && record.claimed.id === id))
      return;
    this.claiming.add(id);
    try {
      let summary: z.infer<typeof operationSummarySchema>;
      try {
        summary = operationSummarySchema.parse(
          await this.call(`/hosted/operations/${id}/claim`, {})
        );
      } catch (error) {
        if (error instanceof WorkerCallError && error.status === 409) return;
        throw error;
      }
      const operation: HostedOperation = {
        id,
        sessionId: summary.session_id,
        action: summary.action,
      };
      await this.operations.append({ claimed: operation });
      this.changed();
      let outcome: OperationOutcome;
      try {
        await port.serial(() => port.operate(operation, this.limit ?? Number.POSITIVE_INFINITY));
        outcome = { id, state: 'applied', error: null };
      } catch (error) {
        if (error instanceof OperationRefusedError)
          outcome = { id, state: 'failed', error: error.message.slice(0, 512) };
        else {
          console.error(`Operation ${id} (${operation.action}) failed: ${describe(error)}`);
          outcome = {
            id,
            state: 'unknown',
            error:
              'The worker could not confirm session startup. Inspect its transcript before retrying.',
          };
        }
      }
      await this.operations.append({ outcome });
      this.changed();
      await this.postResult(outcome);
    } catch (error) {
      this.background(error, `operation ${id}`);
    } finally {
      this.claiming.delete(id);
    }
  }

  private async postResult(outcome: OperationOutcome): Promise<void> {
    try {
      await this.call(`/hosted/operations/${outcome.id}/result`, {
        state: outcome.state,
        error: outcome.error,
      });
    } catch (error) {
      if (!(error instanceof WorkerCallError && error.status === 409)) throw error;
      console.warn(
        `Switch no longer takes the result of operation ${outcome.id} (${error.message}); it is not posted again.`
      );
    }
    await this.operations.append({ posted: outcome.id });
  }

  private async postResults(): Promise<void> {
    const posted = new Set(
      this.operations.records.flatMap((record) => ('posted' in record ? [record.posted] : []))
    );
    for (const record of this.operations.records)
      if ('outcome' in record && !posted.has(record.outcome.id)) {
        try {
          await this.postResult(record.outcome);
        } catch (error) {
          this.background(error, `result of operation ${record.outcome.id}`);
        }
      }
  }

  /** Tells the room why its message was not processed: once per message and reason. */
  async notice(notice: Notice): Promise<void> {
    const key = noticeKey(notice);
    if (
      this.notices.records.some((record) => 'notice' in record && noticeKey(record.notice) === key)
    )
      return;
    await this.notices.append({ notice });
    await this.sendNotice(notice);
  }

  private async sendNotice(notice: Notice): Promise<void> {
    try {
      await this.call(`/agents/${this.agentId}/room-notices`, {
        room_id: notice.roomId,
        message_id: notice.messageId,
        thread_id: notice.threadId,
        reason: notice.reason,
      });
    } catch (error) {
      if (!(error instanceof WorkerCallError && error.status === 404)) {
        this.background(error, `notice to room ${notice.roomId}; it is retried on reattach`);
        return;
      }
      console.error(
        `Switch cannot post the ${notice.reason} notice for message ${notice.messageId} in room ${notice.roomId} (${error.message}); it is not retried.`
      );
    }
    await this.notices.append({ sent: noticeKey(notice) });
  }

  private async sendNotices(): Promise<void> {
    const sent = new Set(
      this.notices.records.flatMap((record) => ('sent' in record ? [record.sent] : []))
    );
    for (const record of this.notices.records)
      if ('notice' in record && !sent.has(noticeKey(record.notice)))
        await this.sendNotice(record.notice);
  }

  /** Records a mailbox ack and sends it with any others still unconfirmed. */
  async ack(ack: MailboxAck): Promise<void> {
    const port = this.port;
    if (!port) throw new Error('The hosted worker is not bound.');
    await port.acks.recordAck(ack);
    void this.flushAcks();
  }

  private flushAcks(): Promise<void> {
    this.acking = this.acking.then(async () => {
      const port = this.port;
      if (!port || !this.attachedState) return;
      for (;;) {
        const batch = port.acks.unconfirmedAcks().slice(0, ACKS_PER_CALL);
        if (!batch.length) return;
        try {
          await this.call(`/agents/${this.agentId}/connection/mailbox/ack`, {
            entries: batch.map((ack) => ({
              room_id: ack.roomId,
              message_id: ack.messageId,
              outcome: ack.outcome,
              ...(ack.reason === undefined ? {} : { reason: ack.reason }),
            })),
          });
        } catch (error) {
          this.background(
            error,
            `mailbox ack of ${batch.length} entr(ies); retried with the next report`
          );
          return;
        }
        await port.acks.confirmAcks(batch);
      }
    });
    return this.acking;
  }

  /** Fetches the provider credential and applies it if it changed; one fetch at a time. */
  refreshCredential(): Promise<void> {
    this.fetchingCredential ??= (async () => {
      const port = this.port;
      if (!port) return;
      try {
        const fetched = await this.credentials.fetch();
        const previous = this.credentialState;
        if (fetched.revoked) {
          if (previous?.revoked) return;
          this.credentialState = { revision: null, revoked: true };
          console.error(
            "The owner's provider connection was removed; stopping every session until it is reconnected."
          );
          await port.revoke();
          this.changed();
          return;
        }
        if (previous && !previous.revoked && previous.revision === fetched.revision) return;
        await fetched.apply();
        this.credentialState = { revision: fetched.revision, revoked: false };
        // The first fetch confirms what the bootstrap put in place before any session started.
        if (!previous) return;
        console.warn(
          'The provider credential changed; each running session restarts under it once it is idle.'
        );
        for (const root of this.links.live()) this.staleHosts.add(root);
        this.restartStale();
      } catch (error) {
        this.background(error, 'provider credential refresh');
      }
    })().finally(() => {
      this.fetchingCredential = null;
    });
    return this.fetchingCredential;
  }

  private restartStale(): void {
    const port = this.port;
    if (!port) return;
    for (const root of [...this.staleHosts]) {
      if (!this.links.ready(root)) {
        this.staleHosts.delete(root);
        continue;
      }
      if (this.links.busy(root)?.busy !== false) continue;
      this.staleHosts.delete(root);
      void port
        .restart(root)
        .catch((error: unknown) =>
          this.background(error, `restart of the session host at ${root}`)
        );
    }
  }

  private epochOf(sessionId: string): string | null {
    return this.links.identity(sharedSessionRoot(sessionId))?.epoch ?? null;
  }
}
