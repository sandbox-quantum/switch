import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentBridgeEvent } from '@sandboxaq/switch-agent-runtime';
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

/**
 * The connection a session's room events arrive over: its agent's, held by the
 * controller that routes to it.
 *
 * Deliberately not strict. A config written when a session served itself also
 * names the rooms and the cursor that connection of its own was opened on;
 * neither is a session's to decide now, and refusing them would leave a
 * session an older app started unopenable by this one.
 */
export const roomConnectionSchema = z.object({ connectionId: z.string().min(1) });
const gapSchema = z
  .strictObject({
    fromSequence: z.number().int().nonnegative(),
    reason: z.string().min(1),
  })
  .nullable();
const receivedSchema = z.strictObject({
  type: z.literal('received'),
  sequence: z.number().int().positive(),
  roomId: z.string().min(1),
  messageId: z.string().min(1),
});
/**
 * Deliveries journaled before the server counted chatter per room carry a
 * tally and a gap note the host worked out for itself. Read and ignored:
 * neither decides anything now, and refusing them would leave an inbox an
 * older app wrote unopenable.
 */
const storedReceivedSchema = receivedSchema.extend({
  missed: z.number().int().nonnegative().optional(),
  gap: gapSchema.optional(),
});
/**
 * An event this session's controller routed here, rather than one its own
 * connection served. Kept apart from a delivery because it says nothing about
 * where that connection has reached.
 */
const handedOverSchema = receivedSchema.extend({ type: z.literal('handoff') });
const recordSchema = z.discriminatedUnion('type', [
  storedReceivedSchema,
  handedOverSchema,
  z.strictObject({
    type: z.literal('ack'),
    sequence: z.number().int().positive(),
    identity: z.string().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal('cursor'),
    sequence: z.number().int().nonnegative(),
    reset: z.boolean(),
    gap: gapSchema,
  }),
  z.strictObject({ type: z.literal('rooms'), rooms: z.array(z.string()) }),
]);
type Received = z.infer<typeof receivedSchema>;
const identity = (event: Pick<Received, 'roomId' | 'messageId'>): string =>
  JSON.stringify([event.roomId, event.messageId]);

export class SharedRoomInbox {
  private readonly received = new Map<string, Received>();
  private readonly outstanding = new Map<string, Received>();
  private rooms: string[] | null = null;
  private constructor(private readonly journal: Journal<z.infer<typeof recordSchema>>) {
    // Only a journal an older app wrote carries deliveries and the position
    // they reached: a session is served by its agent's controller, whose
    // sequence numbers are that connection's rather than this one's. They are
    // still replayed, so a session upgraded mid-flight admits what it was
    // handed before the upgrade and acknowledges it exactly once.
    const sequences = new Map<number, string>();
    let cursor: number | null = null;
    for (const record of journal.records) {
      if (record.type === 'received') {
        if (record.gap && cursor !== null && record.sequence < cursor) sequences.clear();
        const key = identity(record);
        this.received.set(key, record);
        this.outstanding.set(key, record);
        sequences.set(record.sequence, key);
        cursor = record.sequence;
      } else if (record.type === 'handoff') {
        this.hold({ ...record, type: 'received' });
      } else if (record.type === 'ack') {
        const key = record.identity ?? sequences.get(record.sequence);
        if (!key) throw new Error('Room inbox acknowledges an unknown delivery.');
        this.outstanding.delete(key);
      } else if (record.type === 'cursor') {
        if (record.reset) sequences.clear();
        cursor = record.sequence;
      } else this.rooms = record.rooms;
    }
  }

  /**
   * What the server last told this session it serves, and whether it has ever
   * been told a room at all.
   *
   * The two differ where it matters. A session that has never been given a room
   * has yet to register one — the room becomes its own only when the agent
   * inside it connects. A session that held a room and now holds none had it
   * taken away, because a sibling bound the same room and the server evicted
   * this one from it. Both answer with no rooms, and only the first may still
   * be given the room's messages, so the distinction is read from the whole
   * journal rather than from its last record. Null when the session has no
   * journal yet, which is not the same as an empty one.
   */
  static async savedRooms(root: string): Promise<{ rooms: string[]; revoked: boolean } | null> {
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
    let held = false;
    for (const line of text.split('\n').slice(0, -1)) {
      const record = recordSchema.parse(JSON.parse(line));
      if (record.type !== 'rooms') continue;
      rooms = record.rooms;
      held ||= record.rooms.length > 0;
    }
    return rooms === null ? null : { rooms, revoked: held && rooms.length === 0 };
  }

  static async open(root: string): Promise<SharedRoomInbox> {
    return new SharedRoomInbox(
      await Journal.load(join(root, 'room-inbox.jsonl'), (value) => recordSchema.parse(value))
    );
  }

  /**
   * Records the rooms the server says this session serves.
   *
   * Written down because the controller reads it to decide whether an already
   * running session covers a room, and it must be able to do that while the
   * session is stopped and nobody can be asked.
   */
  async serves(rooms: string[]): Promise<void> {
    if (this.rooms !== null && JSON.stringify(this.rooms) === JSON.stringify(rooms)) return;
    await this.journal.append({ type: 'rooms', rooms });
    this.rooms = [...rooms];
  }

  /**
   * Takes an event this session's controller routed here and holds it for
   * admission.
   *
   * Duplicates are dropped on the room and message they name rather than on
   * the position they arrived at: the sequence belongs to the controller's
   * connection, and a session upgraded from one of its own can hold the same
   * event under two of them.
   */
  async accept(event: Pick<Received, 'sequence' | 'roomId' | 'messageId'>): Promise<boolean> {
    const received = receivedSchema.parse({ type: 'received', ...event });
    if (this.received.has(identity(received))) return false;
    await this.journal.append({ ...received, type: 'handoff' });
    this.hold(received);
    return true;
  }

  pending(): Received[] {
    return [...this.outstanding.values()];
  }

  private hold(received: Received): void {
    const key = identity(received);
    this.received.set(key, received);
    this.outstanding.set(key, received);
  }

  async acknowledge(event: Pick<Received, 'sequence' | 'roomId' | 'messageId'>): Promise<void> {
    const key = identity(event);
    if (!this.received.has(key)) throw new Error('Cannot acknowledge an unknown room event.');
    if (!this.outstanding.has(key)) return;
    await this.journal.append({ type: 'ack', sequence: event.sequence, identity: key });
    this.outstanding.delete(key);
  }
}
