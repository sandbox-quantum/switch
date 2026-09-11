import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SharedRoomInbox } from './room-inbox';
it('restores room bindings and outstanding deliveries without repeating acknowledged work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-room-inbox-'));
  try {
    await writeFile(
      join(root, 'room-inbox.jsonl'),
      [
        { type: 'rooms', rooms: ['room'] },
        { type: 'received', sequence: 1, roomId: 'room', messageId: 'one' },
        { type: 'ack', sequence: 1 },
        { type: 'received', sequence: 2, roomId: 'room', messageId: 'two' },
      ]
        .map((record) => JSON.stringify(record) + '\n')
        .join('')
    );
    const inbox = await SharedRoomInbox.open(root);
    expect(inbox.currentRooms()).toEqual(['room']);
    expect(inbox.pending().map((event) => event.messageId)).toEqual(['two']);
    await inbox.acknowledge(2);
    await inbox.acknowledge(2);
    expect((await SharedRoomInbox.open(root)).pending()).toEqual([]);
    await expect(inbox.acknowledge(3)).rejects.toThrow('unknown room event');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
