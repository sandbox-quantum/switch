import { join } from 'node:path';
import { SwitchEventStream } from '@sandboxaq/switch-agent-runtime';
import type { SwitchCredentials } from '@sandboxaq/switch-agent-runtime';
import { z } from 'zod';
import { Journal } from './journal';

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
  private constructor(private readonly journal: Journal<z.infer<typeof recordSchema>>) {}

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
    const savedRooms = [...this.journal.records]
      .reverse()
      .find((record) => record.type === 'rooms');
    const cursor = Math.max(
      connection.startCursor ?? 0,
      ...this.journal.records
        .filter((record) => record.type === 'received')
        .map((record) => record.sequence)
    );
    let rooms = savedRooms?.rooms ?? connection.rooms;
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
          if (event.type !== 'message') {
            console.warn(`Shared SDK room delivery does not support event type ${event.type}.`);
            return;
          }
          const payload = z
            .object({ message_id: z.string().min(1), addressed: z.literal(true) })
            .parse(event.payload);
          const received = receivedSchema.parse({
            type: 'received',
            sequence: event.sequence,
            roomId: event.room_id,
            messageId: payload.message_id,
          });
          const previous = this.journal.records.find(
            (record) => record.type === 'received' && record.sequence === received.sequence
          );
          if (previous) {
            if (JSON.stringify(previous) !== JSON.stringify(received))
              throw new Error('Room delivery sequence changed identity.');
            return;
          }
          await this.journal.append(received);
        },
        onRooms: (next) => {
          void (async () => {
            if (JSON.stringify(next) !== JSON.stringify(rooms)) {
              await this.journal.append({ type: 'rooms', rooms: next });
              rooms = next;
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

  pending(): Received[] {
    const acknowledged = new Set(
      this.journal.records
        .filter((record) => record.type === 'ack')
        .map((record) => record.sequence)
    );
    return this.journal.records.filter(
      (record): record is Received =>
        record.type === 'received' && !acknowledged.has(record.sequence)
    );
  }

  async acknowledge(sequence: number): Promise<void> {
    await this.journal.append({ type: 'ack', sequence });
  }
}
