import { createHash } from 'node:crypto';
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
export const roomConnectionSchema = z.object({
  connectionId: z.string().min(1),
  // A migration hint, never an instruction to take a room from another session.
  restoreRoomId: z.string().min(1).optional(),
});
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
  // The event itself, as the agent's stream delivered it to the controller:
  // what the session's prompt is built from.
  event: z.unknown().optional(),
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
  /**
   * A routed delivery given back unmade, so routing it here again is a fresh
   * attempt rather than a repeat of one this session already finished.
   */
  z.strictObject({
    type: z.literal('release'),
    identity: z.string().min(1),
  }),
  /** What the server answered this session's binding with. */
  z.strictObject({
    type: z.literal('rooms'),
    rooms: z.array(z.string()),
  }),
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
      } else if (record.type === 'release') {
        this.received.delete(record.identity);
        this.outstanding.delete(record.identity);
      } else if (record.type === 'cursor') {
        if (record.reset) sequences.clear();
        cursor = record.sequence;
      } else this.rooms = record.rooms;
    }
  }

  static async open(root: string): Promise<SharedRoomInbox> {
    return new SharedRoomInbox(
      await Journal.load(join(root, 'room-inbox.jsonl'), (value) => recordSchema.parse(value))
    );
  }

  /**
   * Records the rooms the server says this session serves, so what the session
   * was last told is readable after the fact rather than only while it runs.
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
  async accept(
    event: Pick<Received, 'sequence' | 'roomId' | 'messageId' | 'event'>
  ): Promise<boolean> {
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

  /**
   * Gives a routed delivery back without making it.
   *
   * Not an acknowledgement, and the difference is the whole point of it. An
   * acknowledgement is this session's word that the delivery is finished, and
   * it refuses the same room and message for ever after — which is right for
   * one that was made, and wrong for one this session was refused because the
   * room had moved on. A room can move back, and when it does the delivery has
   * still never been made.
   */
  async release(event: Pick<Received, 'roomId' | 'messageId'>): Promise<void> {
    const key = identity(event);
    if (!this.received.has(key)) return;
    await this.journal.append({ type: 'release', identity: key });
    this.received.delete(key);
    this.outstanding.delete(key);
  }

  async acknowledge(event: Pick<Received, 'sequence' | 'roomId' | 'messageId'>): Promise<void> {
    const key = identity(event);
    if (!this.received.has(key)) throw new Error('Cannot acknowledge an unknown room event.');
    if (!this.outstanding.has(key)) return;
    await this.journal.append({ type: 'ack', sequence: event.sequence, identity: key });
    this.outstanding.delete(key);
  }
}
