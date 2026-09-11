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
});
const recordSchema = z.discriminatedUnion('type', [
  receivedSchema,
  z.strictObject({ type: z.literal('ack'), sequence: z.number().int().positive() }),
  z.strictObject({ type: z.literal('rooms'), rooms: z.array(z.string()) }),
]);
type Received = z.infer<typeof receivedSchema>;

export class SharedRoomInbox {
  private readonly received = new Map<number, Received>();
  private readonly outstanding = new Map<number, Received>();
  private rooms: string[] | null = null;
  private cursor = 0;
  private constructor(private readonly journal: Journal<z.infer<typeof recordSchema>>) {
    for (const record of journal.records) {
      if (record.type === 'received') {
        this.received.set(record.sequence, record);
        this.outstanding.set(record.sequence, record);
        this.cursor = Math.max(this.cursor, record.sequence);
      } else if (record.type === 'ack') this.outstanding.delete(record.sequence);
      else this.rooms = record.rooms;
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
    const cursor = Math.max(connection.startCursor ?? 0, this.cursor);
    let rooms = this.rooms ?? connection.rooms;
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      const stream = new SwitchEventStream({
        creds: credentials,
        connectionId: connection.connectionId,
        scope: 'single',
        filter: 'addressed',
        startCursor: cursor || connection.startCursor,
        rooms,
        signal,
        log: console,
        onEvent: async (event) => {
          const messageId = roomInputId(event);
          if (!messageId) return;
          const received = receivedSchema.parse({
            type: 'received',
            sequence: event.sequence,
            roomId: event.room_id,
            messageId,
          });
          const previous = this.received.get(received.sequence);
          if (previous) {
            if (JSON.stringify(previous) !== JSON.stringify(received))
              throw new Error('Room delivery sequence changed identity.');
            return;
          }
          await this.journal.append(received);
          this.received.set(received.sequence, received);
          this.outstanding.set(received.sequence, received);
          this.cursor = Math.max(this.cursor, received.sequence);
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
        onGap: (gap) =>
          fail(new Error(`Room delivery gap: ${gap.reason}. Read room context before continuing.`)),
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

  async acknowledge(sequence: number): Promise<void> {
    if (!this.received.has(sequence)) throw new Error('Cannot acknowledge an unknown room event.');
    if (!this.outstanding.has(sequence)) return;
    await this.journal.append({ type: 'ack', sequence });
    this.outstanding.delete(sequence);
  }
}
