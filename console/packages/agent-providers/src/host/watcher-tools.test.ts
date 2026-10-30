import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionPlacements } from './placements';
import { Redactions } from './redaction';
import type { Caller } from './session-channel';
import { sessionToolAnswerer, WatcherControl, type WatcherHealth } from './watcher-tools';

const calls = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('@sandboxaq/switch-agent-runtime/hosted', () => ({
  SESSION_SELECTOR_HEADERS: {
    sessionId: 'X-Switch-Session-Id',
    hostId: 'X-Switch-Session-Host-Id',
    epoch: 'X-Switch-Session-Epoch',
  },
  loadOperations: async () => [],
  SwitchToolCatalog: class {
    tools() {
      return [];
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
  async function setUp(publish: () => Promise<void>) {
    const base = await mkdtemp(join(tmpdir(), 'watcher-tools-'));
    roots.push(base);
    const placements = await SessionPlacements.open(base, () => []);
    await placements.place('session', 'room-before');
    const answer = sessionToolAnswerer({
      identity: { agentId: 'agent', endpoint: 'https://switch.test', token: 't' },
      connectionId: 'connection',
      placements,
      publish,
      placementsNameCallRooms: () => true,
      redactions: new Redactions(),
    });
    calls.connect.mockResolvedValue({
      content: [{ type: 'text', text: 'connected' }],
      structuredContent: { room_id: 'room-after' },
    });
    return { base, placements, answer };
  }

  it('is refused, and put back, when the controller does not take it', async () => {
    const stated: string[] = [];
    let refuse = true;
    const { base, placements, answer } = await setUp(async () => {
      stated.push(placements.roomOf('session') ?? 'none');
      if (refuse) {
        refuse = false;
        throw new Error('the agent controller hub is not connected');
      }
    });
    const result = (await answer(await caller(base, 'session'), {
      type: 'tool',
      name: 'connect_to_room',
      arguments: { room_id: 'room-after' },
    })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/did not take effect/);
    expect(result.content[0]!.text).toMatch(/the agent controller hub is not connected/);
    expect(placements.roomOf('session')).toBe('room-before');
    // The move, then the map put back, so the next reconnect states that.
    expect(stated).toEqual(['room-after', 'room-before']);
  });

  it('is answered as Switch answered it once the controller takes it', async () => {
    const { base, placements, answer } = await setUp(async () => {});
    const result = (await answer(await caller(base, 'session'), {
      type: 'tool',
      name: 'connect_to_room',
      arguments: { room_id: 'room-after' },
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ room_id: 'room-after' });
    expect(placements.roomOf('session')).toBe('room-after');
  });
});

it('refuses a move behind a controller that left the room out of the placements', async () => {
  // The controller places only rooms it counts the agent as in, and names
  // the rest back; the publish then takes the session out of that room. Told
  // it had connected, the session would call from no room.
  const base = await mkdtemp(join(tmpdir(), 'watcher-tools-'));
  roots.push(base);
  const placements = await SessionPlacements.open(base, () => []);
  await placements.place('session', 'room-before');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let leaveOut = true;
  const answer = sessionToolAnswerer({
    identity: { agentId: 'agent', endpoint: 'https://switch.test', token: 't' },
    connectionId: 'connection',
    placements,
    publish: async () => {
      if (leaveOut) {
        leaveOut = false;
        await placements.roomLost('room-new');
      }
    },
    placementsNameCallRooms: () => true,
    redactions: new Redactions(),
  });
  calls.connect.mockResolvedValue({ content: [{ type: 'text', text: 'connected' }] });
  const result = (await answer(await caller(base, 'session'), {
    type: 'tool',
    name: 'connect_to_room',
    arguments: { room_id: 'room-new' },
  })) as { isError?: boolean; content: { text: string }[] };

  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toMatch(
    /does not count room room-new among this agent's rooms yet/
  );
  expect(placements.roomOf('session')).toBe('room-before');
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
