import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HELD_REPLY_LOST_LINE, HELD_REPLY_NOTICE, HeldReplies } from './held-replies';
import { SessionPlacements } from './placements';
import { takenMac, ticketMac } from './push-key';
import { Redactions } from './redaction';
import type { Caller } from './session-channel';
import { sessionToolAnswerer, WatcherControl, type WatcherHealth } from './watcher-tools';

const calls = vi.hoisted(() => ({ connect: vi.fn(), outcome: vi.fn() }));
vi.mock('@sandboxaq/switch-agent-runtime-box/hosted', () => ({
  SESSION_SELECTOR_HEADERS: {
    sessionId: 'X-Switch-Session-Id',
    hostId: 'X-Switch-Session-Host-Id',
    epoch: 'X-Switch-Session-Epoch',
  },
  loadOperations: async () => [],
  callOperationOutcome: (ctx: { clientTxnId?: string }, name: string, args: unknown) =>
    calls.outcome(ctx.clientTxnId, name, args),
  SwitchToolCatalog: class {
    tools() {
      return [];
    }
    has() {
      return true;
    }
    call(ctx: { selector: Record<string, string> }, name: string, args: unknown) {
      return calls.connect(ctx.selector['X-Switch-Session-Id'], name, args);
    }
  },
}));
vi.mock('./shared-config', () => ({ sharedConfigSchema: { parse: (value: unknown) => value } }));

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function caller(base: string, sessionId: string): Promise<Caller> {
  const root = join(base, sessionId);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({ start: { input: { cwd: root } } }));
  return { agentId: 'agent', sessionId, hostId: 'host', epoch: 'epoch', root };
}

it('moves rooms one at a time, so a refused move puts back only what it replaced', async () => {
  const base = await mkdtemp(join(tmpdir(), 'watcher-tools-'));
  roots.push(base);
  const placements = await SessionPlacements.open(base, () => []);
  const answer = sessionToolAnswerer({
    identity: { agentId: 'agent', apiEndpoint: 'http://127.0.0.1', token: 't' } as never,
    connectionId: 'connection',
    placements,
    publish: async () => {},
    placementsNameCallRooms: () => false,
    redactions: new Redactions(),
  });
  let refuseFirst!: () => void;
  calls.connect.mockImplementation((sessionId: string) =>
    sessionId === 'first'
      ? new Promise((resolve) => {
          refuseFirst = () =>
            resolve({ isError: true, content: [{ type: 'text', text: 'refused' }] });
        })
      : Promise.resolve({ content: [{ type: 'text', text: 'connected' }] })
  );
  const first = answer(await caller(base, 'first'), {
    type: 'tool',
    name: 'connect_to_room',
    arguments: { room_id: 'room' },
  });
  const second = answer(await caller(base, 'second'), {
    type: 'tool',
    name: 'connect_to_room',
    arguments: { room_id: 'room' },
  });
  await vi.waitFor(() => expect(calls.connect).toHaveBeenCalledTimes(1));
  refuseFirst();
  await first;
  await second;
  expect(calls.connect.mock.calls.map(([sessionId]) => sessionId)).toEqual(['first', 'second']);
  expect(placements.sessionIn('room')).toBe('second');
});

it('scrubs every service token handed out from what it sends to Switch', async () => {
  const base = await mkdtemp(join(tmpdir(), 'watcher-tools-'));
  roots.push(base);
  const redactions = new Redactions();
  redactions.add('synthetic-handed_out');
  const answer = sessionToolAnswerer({
    identity: { agentId: 'agent', endpoint: 'https://switch.test', token: 't' },
    connectionId: 'connection',
    placements: await SessionPlacements.open(base, () => []),
    publish: async () => {},
    placementsNameCallRooms: () => false,
    redactions,
  });
  calls.connect.mockResolvedValue({ content: [{ type: 'text', text: 'posted' }] });
  await answer(await caller(base, 'session'), {
    type: 'tool',
    name: 'post_message',
    arguments: { body: 'my token is synthetic-handed_out', mentions: ['synthetic-handed_out'] },
  });
  expect(calls.connect).toHaveBeenCalledWith('session', 'post_message', {
    body: 'my token is [REDACTED]',
    mentions: ['[REDACTED]'],
  });
});

it('answers a service token ask from Switch, as the agent, and scrubs the token from then on', async () => {
  const base = await mkdtemp(join(tmpdir(), 'watcher-tools-'));
  roots.push(base);
  const redactions = new Redactions();
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          token: 'synthetic-issued',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          resources: {},
        })
      )
  );
  vi.stubGlobal('fetch', fetchMock);
  try {
    const answer = sessionToolAnswerer({
      identity: { agentId: 'agent', endpoint: 'https://switch.test/api/agent', token: 'agent-key' },
      connectionId: 'connection',
      placements: await SessionPlacements.open(base, () => []),
      publish: async () => {},
      placementsNameCallRooms: () => false,
      redactions,
    });
    const answered = await answer(await caller(base, 'session'), {
      type: 'service-token',
      service: 'github',
      rejected: null,
    });
    expect(answered).toMatchObject({ kind: 'token', token: 'synthetic-issued' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://switch.test/api/agent/agents/agent/service-tokens/github');
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer agent-key' } });
    expect(redactions.text('synthetic-issued')).toBe('[REDACTED]');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('keeps the watcher health, telling listeners only when something changed', () => {
  const control = new WatcherControl();
  expect(control.health()).toMatchObject({ state: 'not-running', detail: null, placements: {} });
  const heard: WatcherHealth[] = [];
  const stop = control.onHealth((health) => heard.push(health));

  control.report({ state: 'connecting', placements: { one: 'room' } });
  const connecting = control.health().since;
  control.report({ state: 'disconnected', detail: 'refused' });
  control.report({ state: 'disconnected', detail: 'refused' });
  // A new detail on the same state keeps when the state began.
  control.report({ detail: 'refused again' });
  expect(control.health().since).toBe(heard[1]!.since);
  // A new state clears the old detail.
  control.report({ state: 'connected' });
  control.report({ placements: { one: 'room' } });
  control.report({ placements: {} });
  stop();
  control.report({ state: 'not-running', placements: {} });

  expect(heard.map(({ state, detail, placements }) => ({ state, detail, placements }))).toEqual([
    { state: 'connecting', detail: null, placements: { one: 'room' } },
    { state: 'disconnected', detail: 'refused', placements: { one: 'room' } },
    { state: 'disconnected', detail: 'refused again', placements: { one: 'room' } },
    { state: 'connected', detail: null, placements: { one: 'room' } },
    { state: 'connected', detail: null, placements: {} },
  ]);
  expect(heard[0]!.since).toBe(connecting);
  expect(control.health().state).toBe('not-running');
});

it('keeps telling the other listeners when one of them throws', () => {
  const control = new WatcherControl();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const heard: string[] = [];
  control.onHealth(() => {
    throw new Error('broken listener');
  });
  control.onHealth((health) => heard.push(health.state));
  control.report({ state: 'connected' });
  expect(heard).toEqual(['connected']);
  expect(error.mock.calls[0]?.[0]).toContain('broken listener');
  error.mockRestore();
});

it('posts a session’s room reply only into the room it still attends', async () => {
  const base = await mkdtemp(join(tmpdir(), 'watcher-tools-'));
  roots.push(base);
  const placements = await SessionPlacements.open(base, () => []);
  const answer = sessionToolAnswerer({
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

  await expect(
    answer(session, { type: 'room-reply', roomId: 'room', threadId: 'thread', body: 'Hello' })
  ).resolves.toBeNull();
  await answer(session, { type: 'room-reply', roomId: 'room', threadId: null, body: 'Top' });
  expect(calls.connect.mock.calls).toEqual([
    ['session', 'post_message', { body: 'Hello', thread_id: 'thread' }],
    ['session', 'post_message', { body: 'Top' }],
  ]);

  await placements.place('session', 'elsewhere');
  await expect(
    answer(session, { type: 'room-reply', roomId: 'room', threadId: null, body: 'Late' })
  ).rejects.toThrow('no longer attends room room (it attends elsewhere)');
  expect(calls.connect).toHaveBeenCalledTimes(2);

  calls.connect.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'refused' }] });
  await expect(
    answer(session, { type: 'room-reply', roomId: 'elsewhere', threadId: null, body: 'Nope' })
  ).rejects.toThrow('refused');
});

it('reads the instructions of the room a session attends, without moving it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'watcher-tools-'));
  roots.push(base);
  const placements = await SessionPlacements.open(base, () => []);
  const answer = sessionToolAnswerer({
    identity: { agentId: 'agent', apiEndpoint: 'http://127.0.0.1', token: 't' } as never,
    connectionId: 'connection',
    placements,
    publish: async () => {},
    placementsNameCallRooms: () => false,
    redactions: new Redactions(),
  });
  const session = await caller(base, 'session');
  await placements.place('session', 'room');
  calls.connect.mockResolvedValue({
    content: [{ type: 'text', text: '{}' }],
    structuredContent: { instructions: '## Room-specific instructions\n\nSign every reply.' },
  });

  await expect(answer(session, { type: 'room-instructions', roomId: 'room' })).resolves.toEqual({
    instructions: 'Sign every reply.',
  });
  expect(calls.connect.mock.calls).toEqual([
    ['session', 'connect_to_room', { room_id: 'room', include_general_instructions: false }],
  ]);

  calls.connect.mockResolvedValue({
    content: [{ type: 'text', text: '{}' }],
    structuredContent: { instructions: '' },
  });
  await expect(answer(session, { type: 'room-instructions', roomId: 'room' })).resolves.toEqual({
    instructions: '',
  });

  calls.connect.mockResolvedValue({
    content: [{ type: 'text', text: '{}' }],
    structuredContent: {},
  });
  await expect(answer(session, { type: 'room-instructions', roomId: 'room' })).rejects.toThrow(
    'without its instructions'
  );

  await placements.place('session', 'elsewhere');
  await expect(answer(session, { type: 'room-instructions', roomId: 'room' })).rejects.toThrow(
    'no longer attends room room (it attends elsewhere)'
  );
  expect(calls.connect).toHaveBeenCalledTimes(3);
  expect(placements.roomOf('session')).toBe('elsewhere');
});

describe('a move behind an agent controller, whose relay names each call’s room', () => {
  async function setUp(publish: (placements: SessionPlacements) => Promise<void>) {
    const base = await mkdtemp(join(tmpdir(), 'watcher-tools-'));
    roots.push(base);
    const placements = await SessionPlacements.open(base, () => []);
    await placements.place('session', 'room-before');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const answer = sessionToolAnswerer({
      identity: { agentId: 'agent', endpoint: 'https://switch.test', token: 't' },
      connectionId: 'connection',
      placements,
      publish: () => publish(placements),
      placementsNameCallRooms: () => true,
      redactions: new Redactions(),
    });
    calls.connect.mockResolvedValue({
      content: [{ type: 'text', text: 'connected' }],
      structuredContent: { room_id: 'room-after' },
    });
    const connect = async () =>
      (await answer(await caller(base, 'session'), {
        type: 'tool',
        name: 'connect_to_room',
        arguments: { room_id: 'room-after' },
      })) as {
        isError?: boolean;
        content: { text: string }[];
        structuredContent?: Record<string, unknown>;
      };
    return { placements, connect };
  }

  it('is refused, and put back, when the controller does not take it', async () => {
    const stated: string[] = [];
    let refuse = true;
    const { placements, connect } = await setUp(async (held) => {
      stated.push(held.roomOf('session') ?? 'none');
      if (refuse) {
        refuse = false;
        throw new Error('the agent controller hub is not connected');
      }
    });
    const result = await connect();

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/did not take effect/);
    expect(result.content[0]!.text).toMatch(/the agent controller hub is not connected/);
    expect(placements.roomOf('session')).toBe('room-before');
    // The move, then the map put back, so the next reconnect states that.
    expect(stated).toEqual(['room-after', 'room-before']);
  });

  it('is refused when the controller leaves the room out and names it back', async () => {
    // The controller places only rooms it counts the agent as in; the publish
    // then takes the session out of the room it named back. Told it had
    // connected, the session would call from no room.
    let leaveOut = true;
    const { placements, connect } = await setUp(async (held) => {
      if (leaveOut) {
        leaveOut = false;
        await held.roomLost('room-after');
      }
    });
    const result = await connect();

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(
      /does not count room room-after among this agent's rooms yet/
    );
    expect(placements.roomOf('session')).toBe('room-before');
  });

  it('is answered as Switch answered it once the controller takes it', async () => {
    const { placements, connect } = await setUp(async () => {});
    const result = await connect();

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ room_id: 'room-after' });
    expect(placements.roomOf('session')).toBe('room-after');
  });
});

it('keeps a move Switch recorded itself when the stream does not take the placements', async () => {
  // Over the agent's own connection Switch placed the session on connect, so
  // the placements going astray costs nothing a later statement will not fix.
  const base = await mkdtemp(join(tmpdir(), 'watcher-tools-'));
  roots.push(base);
  const placements = await SessionPlacements.open(base, () => []);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const answer = sessionToolAnswerer({
    identity: { agentId: 'agent', endpoint: 'https://switch.test', token: 't' },
    connectionId: 'connection',
    placements,
    publish: async () => {
      throw new Error('timed out');
    },
    placementsNameCallRooms: () => false,
    redactions: new Redactions(),
  });
  calls.connect.mockResolvedValue({ content: [{ type: 'text', text: 'connected' }] });
  const result = (await answer(await caller(base, 'session'), {
    type: 'tool',
    name: 'connect_to_room',
    arguments: { room_id: 'room' },
  })) as { isError?: boolean };

  expect(result.isError).toBeFalsy();
  expect(placements.roomOf('session')).toBe('room');
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/stated again on the next change/));
});

it('posts a restart line through the controller, keyed by its turn, and falls back on an older server', async () => {
  const base = await mkdtemp(join(tmpdir(), 'watcher-tools-'));
  roots.push(base);
  const placements = await SessionPlacements.open(base, () => []);
  const notices: unknown[] = [];
  let outcome: 'posted' | 'unsupported' = 'posted';
  const answer = sessionToolAnswerer({
    restartNotice: async (notice) => {
      notices.push(notice);
      return outcome;
    },
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
    held,
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
  const control = new WatcherControl();
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
