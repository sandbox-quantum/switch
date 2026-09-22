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
  expect(await SharedRoomInbox.savedRooms(root)).toEqual({ rooms: ['room'], everHeld: ['room'] });
  expect(inbox.pending().map((event) => event.messageId)).toEqual(['two']);
  await inbox.acknowledge({ sequence: 2, roomId: 'room', messageId: 'two' });
  await inbox.acknowledge({ sequence: 2, roomId: 'room', messageId: 'two' });
  expect((await SharedRoomInbox.open(root)).pending()).toEqual([]);
  await expect(
    inbox.acknowledge({ sequence: 3, roomId: 'room', messageId: 'three' })
  ).rejects.toThrow('unknown room event');
});

it('writes down the rooms the server says it serves, for a reader it cannot answer', async () => {
  // The controller decides whether a stopped session already covers a room, and
  // a stopped session is in no position to be asked.
  const { root, inbox } = await inboxWith([]);
  await inbox.serves(['room']);
  await inbox.serves(['room']);
  const lines = (await readFile(join(root, 'room-inbox.jsonl'), 'utf8')).split('\n').slice(0, -1);
  expect(lines).toHaveLength(1);
  expect(await SharedRoomInbox.savedRooms(root)).toEqual({ rooms: ['room'], everHeld: ['room'] });
  await inbox.serves(['room', 'other']);
  expect(await SharedRoomInbox.savedRooms(root)).toEqual({
    rooms: ['room', 'other'],
    everHeld: ['room', 'other'],
  });
});

it('reports no saved rooms at all, rather than none, before the first binding', async () => {
  const { root } = await inboxWith([]);
  expect(await SharedRoomInbox.savedRooms(root)).toBeNull();
});

it('tells a room never given apart from one taken away', async () => {
  // Both hold no rooms now. Only the session that has yet to be given one may
  // still be handed the room's messages.
  const { root, inbox } = await inboxWith([]);
  await inbox.serves([]);
  expect(await SharedRoomInbox.savedRooms(root)).toEqual({ rooms: [], everHeld: [] });
  await inbox.serves(['room']);
  await inbox.serves([]);
  expect(await SharedRoomInbox.savedRooms(root)).toEqual({ rooms: [], everHeld: ['room'] });
});

it('remembers a room taken away while the session that lost it was not running', async () => {
  // The answer that would have recorded the eviction never happened: the
  // session died before its next binding, and the empty answer it gives on
  // starting again is the first of that run. What it holds now is not the whole
  // story, and the room it was given once is not its to be handed back.
  const { root, inbox } = await inboxWith([]);
  await inbox.serves(['room']);
  await (await SharedRoomInbox.open(root)).serves([]);
  expect(await SharedRoomInbox.savedRooms(root)).toEqual({ rooms: [], everHeld: ['room'] });
});

it('tells a room a session has moved on from apart from one it still holds', async () => {
  // Being given another room is the same eviction from the first: the sibling
  // that bound it took it, and this session's messages for it end here.
  const { root, inbox } = await inboxWith([]);
  await inbox.serves(['room']);
  await inbox.serves(['other']);
  expect(await SharedRoomInbox.savedRooms(root)).toEqual({
    rooms: ['other'],
    everHeld: ['room', 'other'],
  });
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
