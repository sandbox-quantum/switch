import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as runtime from '@sandboxaq/switch-agent-runtime';
import {
  EVICTION_HEARTBEAT_LAPSED,
  EVICTION_TAKEN_OVER,
  type AgentBridgeEvent,
  type SwitchCredentials,
  type SwitchEventStreamDeps,
} from '@sandboxaq/switch-agent-runtime';
import { afterEach, expect, it, vi } from 'vitest';
import { SharedRoomInbox } from './room-inbox';

const { streams } = vi.hoisted(() => ({ streams: [] as SwitchEventStreamDeps[] }));
// Only the stream is replaced. The eviction codes are the contract under test,
// so a stub of them would let the inbox and the runtime disagree unnoticed.
vi.mock('@sandboxaq/switch-agent-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof runtime>()),
  SwitchEventStream: class {
    constructor(private readonly deps: SwitchEventStreamDeps) {
      streams.push(deps);
    }
    start(): void {
      this.deps.onRooms?.(this.deps.rooms);
    }
  },
}));

const credentials: SwitchCredentials = {
  agentId: 'agent',
  apiEndpoint: 'http://127.0.0.1/agent',
  token: 'token',
};

const message = (sequence: number, addressed: boolean): AgentBridgeEvent => ({
  type: 'message',
  room_id: 'room',
  sequence,
  payload: {
    addressed,
    sender: '@owner:example.test',
    sender_name: 'Owner',
    message_id: `message-${sequence}`,
    body: 'Run the check',
    timestamp: sequence,
  },
});

const roomJoin = (sequence: number): AgentBridgeEvent => ({
  type: 'room_join',
  room_id: 'room',
  sequence,
  payload: {
    member: '@visitor:example.test',
    member_name: 'Visitor',
    timestamp: 1,
    listening: false,
  },
});

const roots: string[] = [];
afterEach(async () => {
  streams.length = 0;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function connected() {
  const root = await mkdtemp(join(tmpdir(), 'sdk-room-inbox-'));
  roots.push(root);
  const inbox = await SharedRoomInbox.open(root);
  const failures: Error[] = [];
  await inbox.connect(
    credentials,
    { connectionId: 'connection', rooms: ['room'] },
    new AbortController().signal,
    (error) => failures.push(error)
  );
  return { root, inbox, failures, stream: streams[streams.length - 1] };
}

it('restores room bindings and outstanding deliveries without repeating acknowledged work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-room-inbox-'));
  roots.push(root);
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
  await inbox.acknowledge({ sequence: 2, roomId: 'room', messageId: 'two' });
  await inbox.acknowledge({ sequence: 2, roomId: 'room', messageId: 'two' });
  expect((await SharedRoomInbox.open(root)).pending()).toEqual([]);
  await expect(
    inbox.acknowledge({ sequence: 3, roomId: 'room', messageId: 'three' })
  ).rejects.toThrow('unknown room event');
});

it('journals only the deliveries the session has to answer', async () => {
  // How far behind the agent is on the rest is Switch's answer to give: it
  // counts per room, and this inbox only ever saw one room's worth.
  const { inbox, stream } = await connected();
  await stream.onEvent(message(1, false));
  await stream.onEvent(message(2, false));
  await stream.onEvent(roomJoin(3));
  await stream.onEvent(message(4, true));
  await stream.onEvent(message(5, false));
  await stream.onEvent(message(6, true));
  expect(inbox.pending()).toEqual([
    { type: 'received', sequence: 4, roomId: 'room', messageId: 'message-4' },
    { type: 'received', sequence: 6, roomId: 'room', messageId: 'message-6' },
  ]);
});

it('keeps streaming after a gap rather than failing the connection', async () => {
  const { inbox, failures, stream } = await connected();
  await stream.onGap({
    fromSequence: 7,
    reason: 'events aged out of the buffer',
    rooms: ['room'],
  });
  await stream.onEvent(message(9, true));
  expect(failures).toEqual([]);
  expect(inbox.pending()).toMatchObject([{ sequence: 9 }]);
});

it('opens a journal whose deliveries carry a tally nothing reads any more', async () => {
  const { root } = await connected();
  await writeFile(
    join(root, 'room-inbox.jsonl'),
    JSON.stringify({
      type: 'received',
      sequence: 3,
      roomId: 'room',
      messageId: 'old',
      missed: 2,
      gap: null,
    }) + '\n',
    { flag: 'a' }
  );
  expect((await SharedRoomInbox.open(root)).pending()).toMatchObject([{ sequence: 3 }]);
});

async function reconnect(root: string) {
  const inbox = await SharedRoomInbox.open(root);
  await inbox.connect(
    credentials,
    { connectionId: 'connection', rooms: ['room'], startCursor: 4 },
    new AbortController().signal,
    vi.fn()
  );
  return { inbox, stream: streams[streams.length - 1] };
}

it('admits an event its controller routed here exactly once, from either direction', async () => {
  // Both paths can see the same event while a session still has a connection of
  // its own. Admitting it twice is a second submission of the same message.
  const { root, inbox, stream } = await connected();
  expect(await inbox.accept({ sequence: 4, roomId: 'room', messageId: 'message-4' })).toBe(true);
  await stream.onEvent(message(4, true));
  await stream.onEvent(message(6, true));
  expect(await inbox.accept({ sequence: 6, roomId: 'room', messageId: 'message-6' })).toBe(false);
  expect(inbox.pending().map((event) => event.messageId)).toEqual(['message-4', 'message-6']);
  await inbox.acknowledge({ sequence: 4, roomId: 'room', messageId: 'message-4' });
  expect((await SharedRoomInbox.open(root)).pending().map((event) => event.messageId)).toEqual([
    'message-6',
  ]);
});

it('does not take the position a controller reached as its own', async () => {
  // The controller reads the same numbering on a different connection. Resuming
  // this session's stream from there would skip everything between.
  const { root, inbox } = await connected();
  await inbox.accept({ sequence: 9, roomId: 'room', messageId: 'routed' });
  const reopened = await reconnect(root);
  expect(reopened.stream.startCursor).toBe(4);
  expect(reopened.inbox.pending().map((event) => event.messageId)).toEqual(['routed']);
});

it('does not read a routed event as this connection’s account of that position', async () => {
  // The controller saw the server restart its numbering before this session
  // did. Holding its sequence as what this stream served there would make the
  // next delivery at that position look like the server contradicting itself.
  const { inbox, stream, failures } = await connected();
  await inbox.accept({ sequence: 1, roomId: 'room', messageId: 'routed-before-the-restart' });
  await stream.onEvent(message(1, true));
  expect(failures).toEqual([]);
  expect(inbox.pending().map((event) => event.messageId)).toEqual([
    'routed-before-the-restart',
    'message-1',
  ]);
});

it('preserves old pending identities across a server reset and host restart', async () => {
  const { root, inbox, stream } = await connected();
  for (const sequence of [1, 3, 4]) await stream.onEvent(message(sequence, true));
  await inbox.acknowledge(inbox.pending()[2]);
  await stream.onGap({ fromSequence: 0, resumedAt: 0, cursorReset: true, reason: 'buffer reset' });
  const next = message(1, true);
  if (!('message_id' in next.payload)) throw new Error('Expected a message');
  next.payload.message_id = 'new-message-1';
  await stream.onEvent(next);
  await inbox.acknowledge(inbox.pending().find((event) => event.messageId === 'new-message-1')!);
  const reopened = await reconnect(root);
  expect(reopened.stream.startCursor).toBe(1);
  expect(reopened.inbox.pending().map((event) => event.messageId)).toEqual([
    'message-1',
    'message-3',
  ]);
  await reopened.stream.onEvent(message(2, true));
  await reopened.inbox.acknowledge(reopened.inbox.pending()[0]);
  expect((await SharedRoomInbox.open(root)).pending().map((event) => event.messageId)).toEqual([
    'message-3',
    'message-2',
  ]);
});

it('restores legacy restart evidence carried on a lower sequence delivery', async () => {
  const { root } = await connected();
  await writeFile(
    join(root, 'room-inbox.jsonl'),
    [
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
    ]
      .map((record) => JSON.stringify(record) + '\n')
      .join('')
  );
  const { inbox, stream } = await reconnect(root);
  expect(stream.startCursor).toBe(1);
  expect(inbox.pending()).toEqual([]);
});

it('retains a zero checkpoint before the next message arrives', async () => {
  const { root, stream } = await connected();
  await stream.onGap({ fromSequence: 0, resumedAt: 0, cursorReset: true, reason: 'buffer reset' });
  const next = await reconnect(root);
  expect(next.stream.startCursor).toBe(0);
  await next.stream.onEvent(message(1, true));
  expect(next.inbox.pending()).toMatchObject([{ sequence: 1 }]);
});

it('keeps the session alive during recoverable eviction, whatever the wording', async () => {
  const { stream, failures } = await connected();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // The prose is free to change; the code is the promise. Matching the prose
  // is what once killed a watcher that only needed to reconnect.
  stream.onEvicted({
    code: EVICTION_HEARTBEAT_LAPSED,
    reason: 'a phrasing no build has ever produced',
    roomId: null,
  });
  expect(failures).toEqual([]);
  expect(warning).toHaveBeenCalledWith(
    'Room heartbeat lapsed; reconnecting from the saved cursor.'
  );
});

it('still fails visibly on a non-recoverable eviction', async () => {
  const { stream, failures } = await connected();
  stream.onEvicted({ code: 'closed', reason: 'credentials revoked', roomId: null });
  expect(failures.map((error) => error.message)).toEqual([
    'Room connection was evicted: credentials revoked',
  ]);
});

it('does not read a takeover as recoverable', async () => {
  const { stream, failures } = await connected();
  stream.onEvicted({
    code: EVICTION_TAKEN_OVER,
    reason: 'another stream attached to this connection and took it over',
    roomId: null,
  });
  expect(failures.map((error) => error.message)).toEqual([
    'Room connection was evicted: another stream attached to this connection and took it over',
  ]);
});
