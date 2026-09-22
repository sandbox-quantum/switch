import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SharedRoomInbox } from './room-inbox';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function inboxWith(records: Record<string, unknown>[]) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-room-inbox-'));
  roots.push(root);
  if (records.length)
    await writeFile(
      join(root, 'room-inbox.jsonl'),
      records.map((record) => JSON.stringify(record) + '\n').join('')
    );
  return { root, inbox: await SharedRoomInbox.open(root) };
}

it('restores room bindings and outstanding deliveries without repeating acknowledged work', async () => {
  const { root, inbox } = await inboxWith([
    { type: 'rooms', rooms: ['room'] },
    { type: 'received', sequence: 1, roomId: 'room', messageId: 'one' },
    { type: 'ack', sequence: 1 },
    { type: 'received', sequence: 2, roomId: 'room', messageId: 'two' },
  ]);
  expect(inbox.pending().map((event) => event.messageId)).toEqual(['two']);
  await inbox.acknowledge({ sequence: 2, roomId: 'room', messageId: 'two' });
  await inbox.acknowledge({ sequence: 2, roomId: 'room', messageId: 'two' });
  expect((await SharedRoomInbox.open(root)).pending()).toEqual([]);
  await expect(
    inbox.acknowledge({ sequence: 3, roomId: 'room', messageId: 'three' })
  ).rejects.toThrow('unknown room event');
});

it('writes down each answer the server gives it, and writes the same one once', async () => {
  const { root, inbox } = await inboxWith([]);
  await inbox.serves(['room']);
  await inbox.serves(['room']);
  await inbox.serves(['room', 'other']);
  const lines = (await readFile(join(root, 'room-inbox.jsonl'), 'utf8')).split('\n').slice(0, -1);
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    { type: 'rooms', rooms: ['room'] },
    { type: 'rooms', rooms: ['room', 'other'] },
  ]);
});

it('admits a routed event exactly once, on the message rather than the position', async () => {
  // A session upgraded from one that served itself can hold the same event
  // under two numberings: its old connection's, and its controller's.
  const { root, inbox } = await inboxWith([
    { type: 'received', sequence: 4, roomId: 'room', messageId: 'message-4' },
  ]);
  expect(await inbox.accept({ sequence: 11, roomId: 'room', messageId: 'message-4' })).toBe(false);
  expect(await inbox.accept({ sequence: 12, roomId: 'room', messageId: 'message-6' })).toBe(true);
  expect(await inbox.accept({ sequence: 12, roomId: 'room', messageId: 'message-6' })).toBe(false);
  expect(inbox.pending().map((event) => event.messageId)).toEqual(['message-4', 'message-6']);
  await inbox.acknowledge({ sequence: 4, roomId: 'room', messageId: 'message-4' });
  expect((await SharedRoomInbox.open(root)).pending().map((event) => event.messageId)).toEqual([
    'message-6',
  ]);
});

it('opens a journal whose deliveries carry a tally nothing reads any more', async () => {
  const { inbox } = await inboxWith([
    { type: 'received', sequence: 3, roomId: 'room', messageId: 'old', missed: 2, gap: null },
  ]);
  expect(inbox.pending()).toMatchObject([{ sequence: 3 }]);
});

it('keeps deliveries a server reset renumbered apart from the ones that replaced them', async () => {
  // Written when the session served itself, so the same sequence stands for two
  // different messages either side of the reset.
  const { inbox } = await inboxWith([
    { type: 'received', sequence: 1, roomId: 'room', messageId: 'message-1' },
    { type: 'received', sequence: 3, roomId: 'room', messageId: 'message-3' },
    { type: 'cursor', sequence: 0, reset: true, gap: { fromSequence: 0, reason: 'buffer reset' } },
    { type: 'received', sequence: 1, roomId: 'room', messageId: 'new-message-1' },
    { type: 'ack', sequence: 1 },
  ]);
  expect(inbox.pending().map((event) => event.messageId)).toEqual(['message-1', 'message-3']);
});

it('restores legacy restart evidence carried on a lower sequence delivery', async () => {
  const { inbox } = await inboxWith([
    { type: 'received', sequence: 3, roomId: 'room', messageId: 'old-three' },
    { type: 'ack', sequence: 3 },
    { type: 'received', sequence: 4, roomId: 'room', messageId: 'old-four' },
    { type: 'ack', sequence: 4 },
    {
      type: 'received',
      sequence: 1,
      roomId: 'room',
      messageId: 'new-one',
      missed: 0,
      gap: { fromSequence: 0, reason: 'buffer reset' },
    },
    { type: 'ack', sequence: 1 },
  ]);
  expect(inbox.pending()).toEqual([]);
});
