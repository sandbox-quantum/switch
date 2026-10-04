import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type AgentBridgeEvent,
  type ApprovalOutcome,
  CONTRACTS,
  type Eviction,
  PlacementsRefusedError,
  type SessionCommand,
  SwitchEventStream,
  type SwitchEventStreamDeps,
} from '@sandboxaq/switch-agent-runtime';
import {
  callOperation,
  type CallerContext,
  fetchMediaToFile,
  SESSION_SELECTOR_HEADERS,
} from '@sandboxaq/switch-agent-runtime/hosted';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessTokens } from './api';
import { silentLogger } from './log';
import { LocalRelay, RELAY_AGENT_PROTOCOL } from './relay';
import { UpstreamForwarder } from './relay-forward';
import type { AgentAssignment } from './schemas';
import { FakeCore } from './testing/fake-core';

const AGENT = 'agent-1';
const quiet = { debug: () => {}, warn: () => {}, error: () => {} };

function assigned(agentId: string): AgentAssignment {
  return {
    agent_id: agentId,
    revision: 1,
    desired_state: 'running',
    definition: {
      name: agentId,
      display_name: null,
      icon_url: null,
      provider: 'claude',
      model: null,
      instructions: '',
      auto_approve: false,
      directory: null,
      isolation: 'shared',
    },
  };
}

function message(sequence: number, addressed: boolean, room = 'room-a') {
  return {
    agent_id: AGENT,
    seq: sequence,
    event: {
      type: 'message',
      room_id: room,
      bridge_id: null,
      channel_type: null,
      payload: {
        addressed,
        sender: '@person:example.org',
        sender_name: 'Person',
        message_id: `$m${sequence}`,
        body: `hello ${sequence}`,
        timestamp: sequence,
      },
      sequence,
      ...(addressed ? { missed: { count: sequence, reason: null } } : {}),
    },
  };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(10);
  }
}

let core: FakeCore;
let relay: LocalRelay;
let token: string;
let revokedCalls: number;
let cursorsSaved: [string, number][];
const stops: (() => void)[] = [];

beforeEach(async () => {
  core = new FakeCore();
  await core.start();
  core.setAssignment({ revision: 1, agents: [assigned(AGENT), assigned('agent-2')] });
  const tokens = new AccessTokens({
    fetch,
    server: core.url,
    controllerId: core.controllerId,
    credential: async () => core.credential,
    now: Date.now,
    log: silentLogger,
  });
  revokedCalls = 0;
  cursorsSaved = [];
  relay = new LocalRelay({
    log: silentLogger,
    version: '0.1.0',
    forwarder: new UpstreamForwarder({
      server: core.url,
      auth: {
        token: () => tokens.get(),
        invalidate: (stale) => tokens.invalidate(stale),
        revoked: () => revokedCalls++,
      },
      log: silentLogger,
    }),
    onCursor: (agentId, cursor) => cursorsSaved.push([agentId, cursor]),
    onChange: () => {},
    sharedRoomFor: (agentId, sessionId) =>
      agentId === 'agent-2' && sessionId === 'session-7' ? 'room-shared' : null,
    now: Date.now,
    timing: { heartbeatTtlMs: 6_000, heartbeatIntervalS: 2, sweepMs: 50, keepaliveMs: 15_000 },
    bufferLimit: 100,
  });
  await relay.start(null);
  token = relay.mint(AGENT);
  relay.streamAttached();
  relay.attach(AGENT, 0, ['room-a', 'room-b']);
  relay.setReady();
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await relay.close();
  await core.stop();
});

type Watcher = ReturnType<typeof watch>;

/** The runtime's own protocol client, pointed at the relay as a watcher points it. */
function watch(overrides: Partial<SwitchEventStreamDeps> = {}) {
  const seen = {
    events: [] as AgentBridgeEvent[],
    gaps: [] as Parameters<SwitchEventStreamDeps['onGap']>[0][],
    evictions: [] as Eviction[],
    commands: [] as SessionCommand[],
    outcomes: [] as ApprovalOutcome[],
    released: [] as { roomId: string; sessionId: string | null }[],
    rooms: [] as string[][],
    connected: 0,
  };
  const controller = new AbortController();
  const stream = new SwitchEventStream({
    creds: { agentId: AGENT, apiEndpoint: relay.endpoint, token },
    connectionId: 'watcher-connection',
    worker: null,
    scope: 'all',
    filter: 'addressed',
    spawnCapable: true,
    rooms: [],
    onEvent: (event) => void seen.events.push(event),
    onGap: (gap) => void seen.gaps.push(gap),
    onEvicted: (eviction) => void seen.evictions.push(eviction),
    onSessionCommand: (command) => void seen.commands.push(command),
    onApprovalOutcome: (outcome) => void seen.outcomes.push(outcome),
    onRoomReleased: (released) => void seen.released.push(released),
    onRooms: (rooms) => void seen.rooms.push(rooms),
    onConnected: () => void seen.connected++,
    log: quiet,
    signal: controller.signal,
    ...overrides,
  });
  stream.start();
  const stop = () => controller.abort();
  stops.push(stop);
  return { stream, seen, stop };
}

async function connected(watcher: Watcher, times = 1): Promise<void> {
  await waitFor(() => watcher.seen.connected >= times, 'the stream to connect');
}

function caller(
  watcher: Watcher,
  overrides: Partial<CallerContext> = {},
  sessionId: string | null = 'session-1'
): CallerContext {
  return {
    identity: { endpoint: relay.endpoint, agentId: AGENT, token },
    connectionId: 'watcher-connection',
    selector: sessionId
      ? {
          [SESSION_SELECTOR_HEADERS.sessionId]: sessionId,
          [SESSION_SELECTOR_HEADERS.hostId]: 'host-1',
          [SESSION_SELECTOR_HEADERS.epoch]: 'epoch-1',
        }
      : {},
    room: null,
    mediaDir: '/nonexistent',
    cwd: '/',
    deadConnection: (operation) => `dead: ${operation}`,
    ...overrides,
  };
}

async function post(path: string, body: unknown, bearer = token): Promise<Response> {
  return fetch(`${relay.endpoint}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('the relay as the agent protocol, read by the real SwitchEventStream', () => {
  it('serves the relay’s protocol range as switch-core declares its own', () => {
    expect(RELAY_AGENT_PROTOCOL).toEqual(CONTRACTS['agent-protocol']['switch-core']);
  });

  it('connects, then delivers addressed events in order, with their ids and missed counts', async () => {
    const watcher = watch();
    await connected(watcher);
    relay.ingest(message(1, true));
    relay.ingest(message(2, false));
    relay.ingest({
      agent_id: AGENT,
      seq: 3,
      event: {
        type: 'command',
        room_id: 'room-a',
        sequence: 3,
        payload: { command: 'reset', args: '', user_id: 'u', user_name: 'U' },
      },
    });
    relay.ingest(message(4, true, 'room-b'));
    await waitFor(() => watcher.seen.events.length === 2, 'two addressed events');
    expect(watcher.seen.events.map((event) => event.sequence)).toEqual([1, 4]);
    expect(watcher.seen.events[0]).toMatchObject({
      type: 'message',
      room_id: 'room-a',
      bridge_id: null,
      missed: { count: 1, reason: null },
    });
    expect(watcher.seen.events[0]).not.toHaveProperty('agent_id');
    expect(watcher.stream.position).toBe(4);
  });

  it('delivers every event to a connection filtering nothing', async () => {
    const watcher = watch({ filter: 'all', connectionId: 'everything' });
    await connected(watcher);
    relay.ingest(message(1, true));
    relay.ingest(message(2, false));
    await waitFor(() => watcher.seen.events.length === 2, 'both events');
  });

  it('resumes from Last-Event-ID without replaying what was read, and opens at head', async () => {
    const first = watch();
    await connected(first);
    relay.ingest(message(1, true));
    relay.ingest(message(2, true));
    await waitFor(() => first.seen.events.length === 2, 'the first two events');
    first.stop();
    relay.ingest(message(3, true));
    relay.ingest(message(4, true));
    const resumed = watch({ startCursor: 2 });
    await waitFor(() => resumed.seen.events.length === 2, 'the events missed while away');
    expect(resumed.seen.events.map((event) => event.sequence)).toEqual([3, 4]);
    const fresh = watch({ connectionId: 'fresh' });
    await connected(fresh);
    relay.ingest(message(5, true));
    await waitFor(() => fresh.seen.events.length === 1, 'only what came after opening');
    expect(fresh.seen.events[0]!.sequence).toBe(5);
  });

  it('confirms the cursor the watcher beats, and only that', async () => {
    const watcher = watch();
    await connected(watcher);
    relay.ingest(message(1, true));
    relay.ingest(message(2, true));
    await waitFor(() => watcher.seen.events.length === 2, 'the events');
    await waitFor(() => relay.cursors()[AGENT] === 2, 'the beat confirming sequence 2', 5000);
    expect(cursorsSaved.at(-1)).toEqual([AGENT, 2]);
    expect(relay.attached(AGENT)).toBe(true);
  });

  it('answers the heartbeat as Switch does: 200, 404 unknown, 409 taken_over or no_stream', async () => {
    const watcher = watch();
    await connected(watcher);
    const unknown = await post(`/agents/${AGENT}/connection/beat`, {
      connection_id: 'nobody',
      cursor: 0,
      generation: 1,
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('nobody is not open');
    const stale = await post(`/agents/${AGENT}/connection/beat`, {
      connection_id: 'watcher-connection',
      cursor: 0,
      generation: 999_999,
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).detail.code).toBe('taken_over');
    const unfenced = await post(`/agents/${AGENT}/connection/beat`, {
      connection_id: 'watcher-connection',
      cursor: 0,
    });
    expect((await unfenced.json()).detail.code).toBe('unfenced');
    watcher.stop();
    await delay(50);
    const detached = await post(`/agents/${AGENT}/connection/beat`, {
      connection_id: 'watcher-connection',
      cursor: 0,
      generation: null,
    });
    expect(detached.status).toBe(409);
  });

  it('evicts the stream another client takes over, and the runtime stands down', async () => {
    const first = watch();
    await connected(first);
    const second = watch();
    await connected(second);
    await waitFor(() => first.seen.evictions.length === 1, 'the first to be evicted');
    expect(first.seen.evictions[0]!.code).toBe('taken_over');
    relay.ingest(message(1, true));
    await waitFor(() => second.seen.events.length === 1, 'the event on the new holder');
    expect(first.seen.events).toEqual([]);
  });

  it('closes a connection whose heartbeat lapses, with an evicted frame', async () => {
    await relay.close();
    relay = new LocalRelay({
      log: silentLogger,
      version: '0.1.0',
      forwarder: { forward: async () => {} },
      onCursor: () => {},
      onChange: () => {},
      sharedRoomFor: () => null,
      now: Date.now,
      timing: { heartbeatTtlMs: 300, heartbeatIntervalS: 2, sweepMs: 20, keepaliveMs: 15_000 },
      bufferLimit: 100,
    });
    await relay.start(null);
    token = relay.mint(AGENT);
    relay.setReady();
    const response = await fetch(
      `${relay.endpoint}/agents/${AGENT}/events?connection_id=raw&scope=all&protocol=6`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } }
    );
    const text = await response.text();
    expect(text).toContain('event: connection_state');
    expect(text).toContain('event: evicted');
    expect(text).toContain('"code":"heartbeat_lapsed"');
  });

  it('tracks placements, names the session’s room on its calls, and routes room controls to it', async () => {
    const watcher = watch();
    await connected(watcher);
    await watcher.stream.replacePlacements({ 'session-1': 'room-a' });
    await waitFor(
      () => watcher.seen.rooms.some((rooms) => rooms.includes('room-a')),
      'the subscription change naming room-a'
    );

    const placed = await callOperation(caller(watcher), 'post_message', { body: 'hi' });
    expect(placed.isError).toBeFalsy();
    expect(placed.structuredContent).toMatchObject({ room_id: 'room-a' });
    const forwarded = core.requests.findLast((r) => r.path.endsWith('/ops/post_message'))!;
    expect(forwarded.headers['x-switch-room-id']).toBe('room-a');
    expect(forwarded.headers['x-switch-agent-id']).toBe(AGENT);
    expect(forwarded.headers['x-switch-session-id']).toBe('session-1');
    expect(forwarded.headers['x-switch-connection-id']).toBeUndefined();
    expect(forwarded.headers.authorization).toMatch(/^Bearer access-token-/);

    const unplaced = await callOperation(caller(watcher, {}, 'session-9'), 'post_message', {});
    expect(unplaced.structuredContent).toMatchObject({ room_id: null });
    const bySoleRoom = await callOperation(caller(watcher, {}, null), 'post_message', {});
    expect(bySoleRoom.structuredContent).toMatchObject({ room_id: 'room-a' });

    relay.sessionCommand({
      agent_id: AGENT,
      room_id: 'room-a',
      command: {
        contractVersion: 1,
        commandId: 'command-1',
        sessionId: null,
        epoch: 'current',
        origin: {
          surface: 'slack',
          actorId: 'u',
          roomId: 'room-a',
          threadId: null,
          messageId: '$x',
        },
        body: { type: 'session.reset' },
        requesterName: 'Person',
      },
    });
    await waitFor(() => watcher.seen.commands.length === 1, 'the room control');
    expect(watcher.seen.commands[0]).toMatchObject({
      sessionId: 'session-1',
      commandId: 'command-1',
      body: { type: 'session.reset' },
      requesterName: 'Person',
    });
    expect(watcher.seen.commands[0]).not.toHaveProperty('room_id');
    expect(watcher.seen.commands[0]).not.toHaveProperty('agent_id');

    relay.sessionCommand({
      agent_id: AGENT,
      room_id: null,
      command: { commandId: 'command-2', origin: { roomId: 'room-b' } },
    });
    await expect(
      watcher.stream.replacePlacements({ 'session-1': 'room-elsewhere' })
    ).rejects.toBeInstanceOf(PlacementsRefusedError);
    await delay(50);
    expect(watcher.seen.commands).toHaveLength(1);
  });

  it('reports the rooms each agent’s sessions work in, across its live connections', async () => {
    expect(relay.sessionRooms()).toEqual({});
    const watcher = watch();
    await connected(watcher);
    await watcher.stream.replacePlacements({ 'session-1': 'room-a' });
    const other = watch({ connectionId: 'other-connection' });
    await connected(other);
    await other.stream.replacePlacements({ 'session-2': 'room-b' });
    expect(relay.sessionRooms()).toEqual({ [AGENT]: ['room-a', 'room-b'] });
    await other.stream.replacePlacements({});
    expect(relay.sessionRooms()).toEqual({ [AGENT]: ['room-a'] });
    await watcher.stream.replacePlacements({});
    expect(relay.sessionRooms()).toEqual({});
  });

  it('leaves out what a connection whose heartbeat lapsed had placed', async () => {
    await relay.close();
    relay = new LocalRelay({
      log: silentLogger,
      version: '0.1.0',
      forwarder: { forward: async () => {} },
      onCursor: () => {},
      onChange: () => {},
      sharedRoomFor: () => null,
      now: Date.now,
      timing: { heartbeatTtlMs: 300, heartbeatIntervalS: 2, sweepMs: 20, keepaliveMs: 15_000 },
      bufferLimit: 100,
    });
    await relay.start(null);
    token = relay.mint(AGENT);
    relay.setReady();
    const response = await fetch(
      `${relay.endpoint}/agents/${AGENT}/events?connection_id=quiet&scope=all&protocol=6`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } }
    );
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const generation = Number(/"generation":(\d+)/.exec(first)![1]);
    const placed = await post(`/agents/${AGENT}/connection/placements`, {
      connection_id: 'quiet',
      placements: { 'session-1': 'room-a' },
      generation,
    });
    expect(placed.status).toBe(200);
    expect(relay.sessionRooms()).toEqual({ [AGENT]: ['room-a'] });
    await waitFor(() => Object.keys(relay.sessionRooms()).length === 0, 'the lapse');
    await reader.cancel();
  });

  it('passes approval outcomes to the watcher', async () => {
    const watcher = watch();
    await connected(watcher);
    relay.approvalOutcome({
      agent_id: AGENT,
      outcome: {
        session_id: 'session-1',
        request_id: 'request-1',
        state: 'answered',
        answer: 'yes',
        answered_by: 'Person',
        answered_at: '2026-01-01T00:00:00Z',
      },
    });
    await waitFor(() => watcher.seen.outcomes.length === 1, 'the outcome');
    expect(watcher.seen.outcomes[0]).toMatchObject({ request_id: 'request-1', answer: 'yes' });
  });

  it('tells a connection its room was taken by a sibling placing a session there', async () => {
    const watcher = watch();
    await connected(watcher);
    await watcher.stream.replacePlacements({ 'session-1': 'room-a' });
    const other = watch({ connectionId: 'other-connection' });
    await connected(other);
    await other.stream.replacePlacements({ 'session-2': 'room-a' });
    await waitFor(() => watcher.seen.released.length === 1, 'room_released');
    expect(watcher.seen.released[0]).toEqual({ roomId: 'room-a', sessionId: 'session-1' });
  });

  it('passes gaps through in order, and a reset as a cursor reset', async () => {
    const watcher = watch();
    await connected(watcher);
    relay.ingest(message(1, true));
    await waitFor(() => watcher.seen.events.length === 1, 'the first event');
    relay.gap({
      agent_id: AGENT,
      from_sequence: 1,
      resumed_at: 10,
      rooms: ['room-a'],
      all_rooms: false,
      reason: 'events older than the retention window were dropped',
    });
    relay.ingest(message(11, true));
    await waitFor(() => watcher.seen.events.length === 2, 'the event after the gap');
    expect(watcher.seen.gaps[0]).toMatchObject({
      fromSequence: 1,
      resumedAt: 10,
      rooms: ['room-a'],
      cursorReset: false,
    });
    relay.gap({
      agent_id: AGENT,
      from_sequence: 11,
      resumed_at: 2,
      rooms: [],
      all_rooms: true,
      reason: 'the server restarted',
    });
    await waitFor(() => watcher.seen.gaps.length === 2, 'the reset');
    expect(watcher.seen.gaps[1]).toMatchObject({ resumedAt: 2, cursorReset: true });
    relay.ingest(message(3, true));
    await waitFor(() => watcher.seen.events.length === 3, 'numbering from the reset');
    expect(relay.cursors()[AGENT]).toBe(2);
  });

  it('drops what a reattached stream replays, and a gap behind what it holds', async () => {
    const watcher = watch();
    await connected(watcher);
    relay.ingest(message(1, true));
    relay.ingest(message(2, true));
    relay.streamAttached();
    relay.attach(AGENT, 0, ['room-a', 'room-b']);
    relay.gap({
      agent_id: AGENT,
      from_sequence: 0,
      resumed_at: 1,
      rooms: ['room-a'],
      all_rooms: false,
      reason: 'dropped',
    });
    relay.ingest(message(1, true));
    relay.ingest(message(2, true));
    relay.ingest(message(3, true));
    await waitFor(() => watcher.seen.events.length === 3, 'the new event');
    expect(watcher.seen.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(watcher.seen.gaps).toEqual([]);
  });

  it('tells a watcher reconnecting from before what the relay still holds that it missed events', async () => {
    relay.setCursor('agent-2', 50);
    const tokenTwo = relay.mint('agent-2');
    const gaps: number[] = [];
    const controller = new AbortController();
    stops.push(() => controller.abort());
    const behind = new SwitchEventStream({
      creds: { agentId: 'agent-2', apiEndpoint: relay.endpoint, token: tokenTwo },
      connectionId: 'behind',
      worker: null,
      scope: 'all',
      filter: 'addressed',
      rooms: [],
      startCursor: 40,
      onEvent: () => {},
      onGap: (gap) => void gaps.push(gap.resumedAt ?? -1),
      onEvicted: () => {},
      log: quiet,
      signal: controller.signal,
    });
    behind.start();
    await waitFor(() => gaps.length === 1, 'the gap');
    expect(gaps[0]).toBe(50);
  });
});

describe('what the relay refuses', () => {
  it('binds to loopback only', () => {
    expect(relay.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('refuses a token it did not mint with 401, and asks to retry while starting', async () => {
    const refused = await post(`/agents/${AGENT}/connection/beat`, {}, 'swlr_not-a-token');
    expect(refused.status).toBe(401);
    const starting = new LocalRelay({
      log: silentLogger,
      version: '0.1.0',
      forwarder: { forward: async () => {} },
      onCursor: () => {},
      onChange: () => {},
      sharedRoomFor: () => null,
      now: Date.now,
      timing: { heartbeatTtlMs: 6_000, heartbeatIntervalS: 2, sweepMs: 50, keepaliveMs: 15_000 },
      bufferLimit: 100,
    });
    await starting.start(null);
    try {
      const early = await fetch(`${starting.endpoint}/agents/${AGENT}/ops`, {
        headers: { Authorization: 'Bearer swlr_unknown' },
      });
      expect(early.status).toBe(503);
    } finally {
      await starting.close();
    }
  });

  it('refuses another agent’s routes, and never relays the management routes', async () => {
    const other = await fetch(`${relay.endpoint}/agents/agent-2/ops`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(other.status).toBe(403);
    for (const path of [
      `/v1/management/controllers/${core.controllerId}/credential/rotate`,
      `/v1/controllers/${core.controllerId}/connection`,
      `/agents/${AGENT}/../../v1/management/controllers/${core.controllerId}/assignment`,
      `/agents/${AGENT}%2F..%2F..%2Fv1/x`,
    ]) {
      const response = await post(path, {});
      expect([403, 404], path).toContain(response.status);
    }
    expect(core.requests.filter((r) => r.path.startsWith('/v1/'))).toEqual([]);
  });

  it('stops accepting an agent’s token once it is unregistered', async () => {
    relay.unregister(AGENT);
    const response = await fetch(`${relay.endpoint}/agents/${AGENT}/ops`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });
});

describe('forwarding to Switch', () => {
  it('swaps the credential, names the agent, and passes the answer back', async () => {
    const response = await fetch(`${relay.endpoint}/agent-sessions/session-1/activity`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Switch-Agent-Id': 'agent-2',
        'X-Switch-Room-Id': 'room-spoofed',
      },
      body: JSON.stringify({ row: 1 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, path: '/agent-sessions/session-1/activity' });
    const forwarded = core.requests.at(-1)!;
    expect(forwarded.headers.authorization).toMatch(/^Bearer access-token-/);
    expect(forwarded.headers['x-switch-agent-id']).toBe(AGENT);
    expect(forwarded.headers['x-switch-room-id']).toBeUndefined();
    expect(forwarded.headers['switch-controller-protocol']).toBe('1');
    expect(forwarded.body).toEqual({ row: 1 });
  });

  it('names the room of a shared agent’s call from its host in the controller', async () => {
    const shared = relay.mint('agent-2');
    const response = await fetch(`${relay.endpoint}/agents/agent-2/ops/post_message`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${shared}`,
        'Content-Type': 'application/json',
        'X-Switch-Session-Id': 'session-7',
      },
      body: JSON.stringify({ body: 'hi' }),
    });
    expect(response.status).toBe(200);
    const forwarded = core.requests.findLast((r) => r.path === '/agents/agent-2/ops/post_message')!;
    expect(forwarded.headers['x-switch-room-id']).toBe('room-shared');
    expect(forwarded.headers['x-switch-agent-id']).toBe('agent-2');
  });

  it('passes an upstream refusal through as it came', async () => {
    core.scripted.push({
      method: 'POST',
      path: `/agents/${AGENT}/ops/connect_to_room`,
      status: 409,
      body: { detail: 'connection watcher-connection is not open' },
    });
    const response = await post(`/agents/${AGENT}/ops/connect_to_room`, { room_id: 'room-a' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ detail: 'connection watcher-connection is not open' });
  });

  it('exchanges a token Switch refused as stale and sends the request once more', async () => {
    await post(`/agents/${AGENT}/ops/post_message`, {});
    core.expireTokens();
    const response = await post(`/agents/${AGENT}/ops/post_message`, { body: 'again' });
    expect(response.status).toBe(200);
    expect(core.tokensIssued).toBe(2);
  });

  it('reports a revoked controller, and answers 502 when Switch is unreachable', async () => {
    core.revoked = true;
    const revoked = await post(`/agents/${AGENT}/ops/post_message`, {});
    expect(revoked.status).toBe(401);
    expect(revokedCalls).toBe(1);
    await core.stop();
    const unreachable = await post(`/agents/${AGENT}/ops/post_message`, {});
    expect(unreachable.status).toBe(502);
  });

  it('streams an upload through without holding it', async () => {
    const chunk = Buffer.alloc(64 * 1024, 7);
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(`${relay.endpoint}/agents/${AGENT}/rooms/room-a/media`);
      const upload = request(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      });
      upload.on('response', (response) => {
        let body = '';
        response.on('data', (data: Buffer) => (body += data.toString()));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      upload.on('error', reject);
      upload.write(chunk);
      // The rest is sent only once Switch has the first part: a relay that
      // read the whole body before forwarding would wait here forever.
      void waitFor(() => core.uploadReceived >= chunk.length, 'the first part upstream')
        .then(() => {
          upload.write(chunk);
          upload.end();
        })
        .catch(reject);
    });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ received: chunk.length * 2 });
  });

  it('streams a download through, and the runtime writes it to a file', async () => {
    let release: () => void = () => {};
    core.waitBetweenChunks = new Promise<void>((resolve) => (release = resolve));
    core.mediaChunks = [Buffer.from('first-part-'), Buffer.from('second-part')];
    const response = await fetch(`${relay.endpoint}/agents/${AGENT}/rooms/room-a/media?mxc=x`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    // The first part arrived while Switch still holds back the second.
    expect(Buffer.from(first.value!).toString()).toBe('first-part-');
    release();
    let rest = '';
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += Buffer.from(next.value).toString();
    }
    expect(rest).toBe('second-part');

    core.waitBetweenChunks = null;
    const dir = mkdtempSync(join(tmpdir(), 'relay-media-'));
    try {
      const written = await fetchMediaToFile(
        { endpoint: relay.endpoint, agentId: AGENT, token },
        dir,
        'room-a',
        'mxc://example.org/abc',
        'file.bin'
      );
      expect(readFileSync(written, 'utf8')).toBe('first-part-second-part');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
