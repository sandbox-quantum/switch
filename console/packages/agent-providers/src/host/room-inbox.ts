import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SwitchEventStream } from '@sandboxaq/switch-agent-runtime';
import type { AgentBridgeEvent, SwitchCredentials } from '@sandboxaq/switch-agent-runtime';
import { z } from 'zod';
import { Journal } from './journal';

export function roomInputId(event: AgentBridgeEvent): string | null {
  if (event.type === 'message')
    return 'addressed' in event.payload &&
      event.payload.addressed === true &&
      'message_id' in event.payload
      ? String(event.payload.message_id)
      : null;
  if (
    event.type === 'room_join' &&
    (!('listening' in event.payload) || event.payload.listening !== true)
  )
    return null;
  if (event.type !== 'room_join' && !event.type.startsWith('task_')) return null;
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, entry]) => [key, sorted(entry)])
          )
        : value;
  return `${event.type}:${createHash('sha256')
    .update(JSON.stringify(sorted(event.payload)))
    .digest('hex')}`;
}

export const roomConnectionSchema = z.strictObject({
  connectionId: z.string().min(1),
  rooms: z.array(z.string().min(1)),
  startCursor: z.number().int().nonnegative().optional(),
});
const receivedSchema = z.strictObject({
  type: z.literal('received'),
  sequence: z.number().int().positive(),
  roomId: z.string().min(1),
  messageId: z.string().min(1),
  missed: z.number().int().nonnegative(),
  gap: z
    .strictObject({
      fromSequence: z.number().int().nonnegative(),
      reason: z.string().min(1),
    })
    .nullable(),
});
/** Deliveries journaled before a tally was recorded carry neither field. */
const storedReceivedSchema = receivedSchema.extend({
  missed: receivedSchema.shape.missed.default(0),
  gap: receivedSchema.shape.gap.default(null),
});
const recordSchema = z.discriminatedUnion('type', [
  storedReceivedSchema,
  z.strictObject({
    type: z.literal('ack'),
    sequence: z.number().int().positive(),
    identity: z.string().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal('cursor'),
    sequence: z.number().int().nonnegative(),
    reset: z.boolean(),
    gap: receivedSchema.shape.gap,
  }),
  z.strictObject({ type: z.literal('rooms'), rooms: z.array(z.string()) }),
]);
type Received = z.infer<typeof receivedSchema>;
const identity = (event: Pick<Received, 'roomId' | 'messageId'>): string =>
  JSON.stringify([event.roomId, event.messageId]);

export class SharedRoomInbox {
  private readonly received = new Map<string, Received>();
  private readonly outstanding = new Map<string, Received>();
  private readonly sequences = new Map<number, string>();
  private rooms: string[] | null = null;
  private cursor: number | null = null;
  private missed = 0;
  private gap: Received['gap'] = null;
  private constructor(private readonly journal: Journal<z.infer<typeof recordSchema>>) {
    for (const record of journal.records) {
      if (record.type === 'received') {
        // Older journals carried restart evidence only on the next delivery.
        if (record.gap && this.cursor !== null && record.sequence < this.cursor)
          this.sequences.clear();
        const key = identity(record);
        this.received.set(key, record);
        this.outstanding.set(key, record);
        this.sequences.set(record.sequence, key);
        this.cursor = record.sequence;
        this.gap = null;
      } else if (record.type === 'ack') {
        const key = record.identity ?? this.sequences.get(record.sequence);
        if (!key) throw new Error('Room inbox acknowledges an unknown delivery.');
        this.outstanding.delete(key);
      } else if (record.type === 'cursor') {
        if (record.reset) this.sequences.clear();
        this.cursor = record.sequence;
        this.gap = record.gap;
      } else this.rooms = record.rooms;
    }
  }

  static async savedRooms(root: string): Promise<string[] | null> {
    let text: string;
    try {
      text = await readFile(join(root, 'room-inbox.jsonl'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (text && !text.endsWith('\n'))
      throw new Error('Room inbox has an incomplete record; recovery review is required.');
    let rooms: string[] | null = null;
    for (const line of text.split('\n').slice(0, -1)) {
      const record = recordSchema.parse(JSON.parse(line));
      if (record.type === 'rooms') rooms = record.rooms;
    }
    return rooms;
  }

  static async open(root: string): Promise<SharedRoomInbox> {
    return new SharedRoomInbox(
      await Journal.load(join(root, 'room-inbox.jsonl'), (value) => recordSchema.parse(value))
    );
  }

  async connect(
    credentials: SwitchCredentials,
    connection: z.infer<typeof roomConnectionSchema>,
    signal: AbortSignal,
    fail: (error: Error) => void
  ): Promise<void> {
    const cursor = this.cursor ?? connection.startCursor;
    let rooms = this.rooms ?? connection.rooms;
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      const stream = new SwitchEventStream({
        creds: credentials,
        connectionId: connection.connectionId,
        scope: 'single',
        filter: 'all',
        startCursor: cursor,
        rooms,
        signal,
        log: console,
        onEvent: async (event) => {
          const messageId = roomInputId(event);
          if (!messageId) {
            if (event.type === 'message') this.missed += 1;
            return;
          }
          const received = receivedSchema.parse({
            type: 'received',
            sequence: event.sequence,
            roomId: event.room_id,
            messageId,
            missed: this.missed,
            gap: this.gap,
          });
          const key = identity(received);
          const previous = this.sequences.get(received.sequence);
          if (previous && previous !== key)
            throw new Error('Room delivery sequence changed identity.');
          if (this.received.has(key)) return;
          await this.journal.append(received);
          this.received.set(key, received);
          this.outstanding.set(key, received);
          this.sequences.set(received.sequence, key);
          this.cursor = received.sequence;
          this.missed = 0;
          this.gap = null;
        },
        onRooms: (next) => {
          void (async () => {
            if (this.rooms === null || JSON.stringify(next) !== JSON.stringify(rooms)) {
              await this.journal.append({ type: 'rooms', rooms: next });
              rooms = next;
              this.rooms = [...next];
            }
            signal.removeEventListener('abort', aborted);
            resolve();
          })().catch((error: Error) => {
            reject(error);
            fail(error);
          });
        },
        // A gap costs the agent context, not the connection: the stream keeps
        // serving from wherever it resumed, and the warning rides on the next
        // delivery so the agent reads the room before it answers.
        onGap: async (gap) => {
          console.warn(`Room delivery gap: ${gap.reason}. Read room context before continuing.`);
          const detail = { fromSequence: gap.fromSequence, reason: gap.reason };
          if (gap.resumedAt !== undefined) {
            await this.journal.append({
              type: 'cursor',
              sequence: gap.resumedAt,
              reset: gap.cursorReset === true,
              gap: detail,
            });
            this.cursor = gap.resumedAt;
            if (gap.cursorReset) {
              this.sequences.clear();
              this.missed = 0;
            }
          }
          this.gap = detail;
        },
        onEvicted: (reason) => {
          if (reason === 'heartbeat lapsed')
            console.warn('Room heartbeat lapsed; reconnecting from the saved cursor.');
          else fail(new Error(`Room connection was evicted: ${reason}`));
        },
        onRoomRejected: ({ roomId, detail }) =>
          fail(new Error(`Room ${roomId} was refused: ${detail}`)),
      });
      stream.start();
    });
  }

  currentRooms(): string[] {
    return [...(this.rooms ?? [])];
  }

  pending(): Received[] {
    return [...this.outstanding.values()];
  }

  async acknowledge(event: Pick<Received, 'sequence' | 'roomId' | 'messageId'>): Promise<void> {
    const key = identity(event);
    if (!this.received.has(key)) throw new Error('Cannot acknowledge an unknown room event.');
    if (!this.outstanding.has(key)) return;
    await this.journal.append({ type: 'ack', sequence: event.sequence, identity: key });
    this.outstanding.delete(key);
  }
}
