import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionPlacements } from '../placements';
import { Redactions } from '../redaction';
import type { Caller } from '../session-channel';
import { type RestartNotice, sessionToolAnswerer } from '../watcher-tools';
import { HELD_REPLY_LOST_LINE, HELD_REPLY_NOTICE, HeldReplies } from './held-replies';
import { takenMac, ticketMac } from './push-key';
import { HubTickets, watcherBox } from './watcher-box';

/** The answerer's box half, as a box's agent host builds it. */
function box(input: { held?: HeldReplies; restartNotice?: RestartNotice }) {
  return watcherBox({
    held: input.held ?? new HeldReplies({}),
    tickets: new HubTickets(),
    ...(input.restartNotice ? { restartNotice: input.restartNotice } : {}),
  });
}

const calls = vi.hoisted(() => ({
  connect: vi.fn(),
  outcome: vi.fn(),
  load: vi.fn(async (): Promise<{ name: string }[]> => []),
}));
vi.mock('@sandboxaq/switch-agent-runtime/hosted', () => ({
  SESSION_SELECTOR_HEADERS: {
    sessionId: 'X-Switch-Session-Id',
    hostId: 'X-Switch-Session-Host-Id',
    epoch: 'X-Switch-Session-Epoch',
  },
  loadOperations: () => calls.load(),
  callOperationOutcome: (ctx: { clientTxnId?: string }, name: string, args: unknown) =>
    calls.outcome(ctx.clientTxnId, name, args),
  SwitchToolCatalog: class {
    constructor(readonly operations: { name: string }[]) {}
    tools() {
      return this.operations;
    }
    has(name: string) {
      return this.operations.length === 0 || this.operations.some((op) => op.name === name);
    }
    call(ctx: { selector: Record<string, string> }, name: string, args: unknown) {
      return calls.connect(ctx.selector['X-Switch-Session-Id'], name, args);
    }
  },
}));
vi.mock('../shared-config', () => ({ sharedConfigSchema: { parse: (value: unknown) => value } }));

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  calls.load.mockImplementation(async () => []);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function caller(base: string, sessionId: string): Promise<Caller> {
  const root = join(base, sessionId);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({ start: { input: { cwd: root } } }));
  return { agentId: 'agent', sessionId, hostId: 'host', epoch: 'epoch', root };
}

it('posts a restart line through the controller, keyed by its turn, and falls back on an older server', async () => {
  const base = await mkdtemp(join(tmpdir(), 'watcher-tools-'));
  roots.push(base);
  const placements = await SessionPlacements.open(base, () => []);
  const notices: unknown[] = [];
  let outcome: 'posted' | 'unsupported' = 'posted';
  const answer = sessionToolAnswerer({
    box: box({
      restartNotice: async (notice) => {
        notices.push(notice);
        return outcome;
      },
    }),
    identity: { agentId: 'agent', apiEndpoint: 'http://127.0.0.1', token: 't' } as never,
    connectionId: 'connection',
    placements,
    publish: async () => {},
    placementsNameCallRooms: () => false,
    redactions: new Redactions(),
  });
  calls.connect.mockResolvedValue({ content: [{ type: 'text', text: '{"event_id":"e"}' }] });
  const session = await caller(base, 'session');
  await placements.place('session', 'room');
  const line = {
    type: 'room-reply' as const,
    roomId: 'room',
    threadId: 'thread-1',
    body: 'I was restarted while working on this and lost my reply. Please send it again.',
    restartTurnId: 'cut-off',
  };

  // Keyed through the controller: no room check, no agent post.
  await expect(answer(session, line)).resolves.toEqual({ posted: true });
  expect(notices).toEqual([{ roomId: 'room', threadId: 'thread-1', turnId: 'cut-off' }]);
  expect(calls.connect).not.toHaveBeenCalled();

  // A server from before the route: the line goes the older way, as the session.
  outcome = 'unsupported';
  await answer(session, line);
  expect(calls.connect.mock.calls).toEqual([
    ['session', 'post_message', { body: line.body, thread_id: 'thread-1' }],
  ]);

  // Not the session's room any more: refused before anything is posted.
  await placements.place('session', 'elsewhere');
  await expect(answer(session, line)).rejects.toThrow('no longer attends room room');
  expect(notices).toHaveLength(2);
});

it('checks the room before a once reply, and posts it only when the line is not already there', async () => {
  const base = await mkdtemp(join(tmpdir(), 'watcher-tools-'));
  roots.push(base);
  const placements = await SessionPlacements.open(base, () => []);
  const answer = sessionToolAnswerer({
    box: box({}),
    identity: { agentId: 'agent', apiEndpoint: 'http://127.0.0.1', token: 't' } as never,
    connectionId: 'connection',
    placements,
    publish: async () => {},
    placementsNameCallRooms: () => false,
    redactions: new Redactions(),
  });
  const session = await caller(base, 'session');
  await placements.place('session', 'room');
  const line = 'I was restarted. Please send it again.';
  const entry = (id: string, sender: string, body: string, timestamp: number) => ({
    id,
    kind: 'message',
    sender: `@${sender}:test`,
    sender_name: sender,
    body,
    timestamp,
    attachments: [],
  });
  let threads: unknown[] = [];
  const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  calls.connect.mockImplementation((_session: string, name: string) => {
    if (name === 'get_agent_detail')
      return Promise.resolve(text({ name: 'eng', display_name: null }));
    if (name === 'read_context') return Promise.resolve(text({ threads, truncated: false }));
    return Promise.resolve(text({ event_id: 'posted' }));
  });
  const ask = {
    type: 'room-reply' as const,
    roomId: 'room',
    threadId: 'thread',
    body: line,
    once: { afterMessageId: 'asked' },
  };
  const posts = () => calls.connect.mock.calls.filter(([, name]) => name === 'post_message').length;

  // Not there yet: posted.
  threads = [
    {
      root: entry('thread', 'person', 'start', 1),
      replies: [entry('asked', 'person', 'do it', 2)],
    },
  ];
  await expect(answer(session, ask)).resolves.toEqual({ posted: true });
  expect(posts()).toBe(1);

  // Another agent's identical line, a line of ours before the message, and one in another thread don't count.
  threads = [
    {
      root: entry('thread', 'person', 'start', 1),
      replies: [
        entry('old', 'eng', line, 1),
        entry('asked', 'person', 'do it', 2),
        entry('x', 'pm', line, 3),
      ],
    },
    { root: entry('other', 'eng', line, 4), replies: [] },
  ];
  await expect(answer(session, ask)).resolves.toEqual({ posted: true });
  expect(posts()).toBe(2);

  // Our line is already there (an earlier post whose answer was lost), with a Switch Trust note: not posted again.
  threads = [
    {
      root: entry('thread', 'person', 'start', 1),
      replies: [entry('asked', 'person', 'do it', 2), entry('mine', 'eng', `${line}\n⚠️ note`, 3)],
    },
  ];
  await expect(answer(session, ask)).resolves.toEqual({ posted: false });
  expect(posts()).toBe(2);

  // The check reads only the session's own room, as the session.
  expect(
    calls.connect.mock.calls
      .filter(([, name]) => name === 'read_context')
      .map(([s, , args]) => [s, args])
  ).toEqual(Array(3).fill(['session', { limit: 200 }]));

  // A failed check posts nothing: never blind.
  calls.connect.mockImplementation((_session: string, name: string) =>
    name === 'read_context'
      ? Promise.resolve({ isError: true, content: [{ type: 'text', text: 'down' }] })
      : Promise.resolve(text({ name: 'eng', display_name: null }))
  );
  await expect(answer(session, ask)).rejects.toThrow('Could not check the room first: down');
  expect(posts()).toBe(2);
});

it('tells the room, in the thread, that a held reply was lost when Switch refuses it once back', async () => {
  const base = await mkdtemp(join(tmpdir(), 'watcher-tools-'));
  roots.push(base);
  const placements = await SessionPlacements.open(base, () => []);
  await placements.place('session', 'room');
  const log = { info: vi.fn(), warn: vi.fn() };
  const held = new HeldReplies({
    log,
    windowMs: 60,
    retryMs: [10],
    lostRetryMs: 10,
    lostWindowMs: 5_000,
  });
  const answer = sessionToolAnswerer({
    identity: { agentId: 'agent', endpoint: 'https://switch.test', token: 't' },
    connectionId: 'connection',
    placements,
    publish: async () => {},
    placementsNameCallRooms: () => false,
    redactions: new Redactions(),
    box: box({ held }),
  });
  const switchBack = { now: false };
  calls.outcome.mockImplementation(async (key: string) => {
    if (!switchBack.now)
      return {
        result: { isError: true, content: [{ type: 'text', text: 'post_message failed' }] },
        unavailable: true,
      };
    // Back, but it won't take the reply itself (the agent left the room, say).
    if (!key.endsWith(':lost'))
      return {
        result: { isError: true, content: [{ type: 'text', text: '403: not a member' }] },
        unavailable: false,
      };
    return { result: { content: [{ type: 'text', text: '{}' }] }, unavailable: false };
  });
  const told = await answer(await caller(base, 'session'), {
    type: 'tool',
    name: 'post_message',
    arguments: { body: 'the reply', thread_id: 'thread-1' },
  });
  expect(told).toEqual({ content: [{ type: 'text', text: HELD_REPLY_NOTICE }] });
  await vi.waitFor(() =>
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('It was not posted.'))
  );
  const awayTries = calls.outcome.mock.calls.length;
  switchBack.now = true;
  held.retryNow();
  await vi.waitFor(() =>
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/^Told room room that held reply/))
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  const [key] = calls.outcome.mock.calls[0]!;
  expect(key).toMatch(/^reply:/);
  // Once more under its own key, refused; then the line, once, in its thread.
  expect(calls.outcome.mock.calls.slice(awayTries)).toEqual([
    [key, 'post_message', { body: 'the reply', thread_id: 'thread-1' }],
    [`${key}:lost`, 'post_message', { body: HELD_REPLY_LOST_LINE, thread_id: 'thread-1' }],
  ]);
  expect(held.size).toBe(0);
  // Logged by status only, never Switch's own words.
  const lines = [...log.warn.mock.calls, ...log.info.mock.calls].map(([line]) => String(line));
  expect(lines.some((line) => line.includes('Switch answered 403'))).toBe(true);
  expect(lines.some((line) => line.includes('not a member'))).toBe(false);
});

it('hands each hub ticket over once, newest kept, and gives up waiting after its timeout', async () => {
  const control = new HubTickets();
  const key = Buffer.alloc(32, 3);
  control.setPushKey(key);
  const give = (ticket: string) => control.giveHubTicket(ticket, ticketMac(key, ticket));
  expect(await control.takeHubTicket(20)).toBeUndefined();
  expect(give('a'.repeat(32))).toBe(takenMac(key, 'a'.repeat(32)));
  give('b'.repeat(32));
  expect(await control.takeHubTicket(20)).toBe('b'.repeat(32));
  expect(await control.takeHubTicket(20)).toBeUndefined();
  const waiting = control.takeHubTicket(1_000);
  give('c'.repeat(32));
  expect(await waiting).toBe('c'.repeat(32));
  // One with a bad HMAC is ignored, and replaces nothing.
  give('d'.repeat(32));
  expect(control.giveHubTicket('e'.repeat(32), ticketMac(key, 'x'))).toBeNull();
  expect(await control.takeHubTicket(20)).toBe('d'.repeat(32));
});
