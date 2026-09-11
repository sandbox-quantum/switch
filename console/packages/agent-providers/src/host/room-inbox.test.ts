import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentBridgeEvent,
  SwitchCredentials,
  SwitchEventStreamDeps,
} from '@sandboxaq/switch-agent-runtime';
import { afterEach, expect, it, vi } from 'vitest';
import { SharedRoomInbox } from './room-inbox';

const { streams } = vi.hoisted(() => ({ streams: [] as SwitchEventStreamDeps[] }));
vi.mock('@sandboxaq/switch-agent-runtime', () => ({
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
  await inbox.acknowledge(2);
  await inbox.acknowledge(2);
  expect((await SharedRoomInbox.open(root)).pending()).toEqual([]);
  await expect(inbox.acknowledge(3)).rejects.toThrow('unknown room event');
});

it('carries the unaddressed tally on the next delivery and starts counting again', async () => {
  const { inbox, stream } = await connected();
  await stream.onEvent(message(1, false));
  await stream.onEvent(message(2, false));
  await stream.onEvent(roomJoin(3));
  await stream.onEvent(message(4, true));
  expect(inbox.pending()).toMatchObject([{ sequence: 4, missed: 2, gap: null }]);
  await stream.onEvent(message(5, false));
  await stream.onEvent(message(6, true));
  expect(inbox.pending()).toMatchObject([
    { sequence: 4, missed: 2 },
    { sequence: 6, missed: 1 },
  ]);
});

it('keeps streaming after a gap and warns on the next delivery instead', async () => {
  const { inbox, failures, stream } = await connected();
  stream.onGap({ fromSequence: 7, reason: 'events aged out of the buffer' });
  await stream.onEvent(message(9, true));
  expect(failures).toEqual([]);
  expect(inbox.pending()).toMatchObject([
    { sequence: 9, missed: 0, gap: { fromSequence: 7, reason: 'events aged out of the buffer' } },
  ]);
  await stream.onEvent(message(10, true));
  expect(inbox.pending()[1]).toMatchObject({ sequence: 10, gap: null });
});

it('reloads deliveries journaled before a tally was recorded', async () => {
  const { root, inbox, stream } = await connected();
  await stream.onEvent(message(1, false));
  await stream.onEvent(message(2, true));
  await writeFile(
    join(root, 'room-inbox.jsonl'),
    JSON.stringify({ type: 'received', sequence: 3, roomId: 'room', messageId: 'old' }) + '\n',
    { flag: 'a' }
  );
  expect(inbox.pending()).toMatchObject([{ sequence: 2, missed: 1 }]);
  expect((await SharedRoomInbox.open(root)).pending()).toMatchObject([
    { sequence: 2, missed: 1, gap: null },
    { sequence: 3, missed: 0, gap: null },
  ]);
});
