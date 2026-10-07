import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AgentBridgeEvent,
  ApprovalOutcome,
  Eviction,
  SessionCommand,
  SwitchEventStreamDeps,
} from '@sandboxaq/switch-agent-runtime';
import {
  callOperation,
  type CallerContext,
  fetchMediaToFile,
  SESSION_SELECTOR_HEADERS,
} from '@sandboxaq/switch-agent-runtime/hosted';
import { type AgentEventStream, openHubStream } from '@switch-console/agent-providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AgentHub } from './agent-hub';
import { AccessTokens } from './api';
import { HubSocket } from './hub-socket';
import { silentLogger } from './log';
import { LocalRelay } from './relay';
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
      advanced_config: {},
      instructions: '',
      auto_approve: false,
      directory: null,
      isolation: 'isolated',
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
let hub: AgentHub;
let relay: LocalRelay;
let token: string;
let revokedCalls: number;
let cursorsSaved: [string, number][];
const stops: (() => void)[] = [];

function newRelay(): LocalRelay {
  const tokens = new AccessTokens({
    fetch,
    server: core.url,
    controllerId: core.controllerId,
    credential: async () => core.credential,
    now: Date.now,
    log: silentLogger,
  });
  return new LocalRelay({
    log: silentLogger,
    roomFor: (agentId, sessionId) => hub.roomFor(agentId, sessionId),
    hub: new HubSocket({ hub, log: silentLogger }),
    forwarder: new UpstreamForwarder({
      server: core.url,
      auth: {
        token: () => tokens.get(),
        invalidate: (stale) => tokens.invalidate(stale),
        revoked: () => revokedCalls++,
      },
      log: silentLogger,
    }),
  });
}

beforeEach(async () => {
  core = new FakeCore();
  await core.start();
  core.setAssignment({ revision: 1, agents: [assigned(AGENT), assigned('agent-2')] });
  revokedCalls = 0;
  cursorsSaved = [];
  hub = new AgentHub({
    log: silentLogger,
    bufferLimit: 100,
    onCursor: (agentId, cursor) => cursorsSaved.push([agentId, cursor]),
    onChange: () => {},
  });
  relay = newRelay();
  await relay.start(null);
  token = relay.mint(AGENT);
  hub.streamAttached();
  hub.attach(AGENT, 0, ['room-a', 'room-b']);
  relay.setReady();
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await relay.close();
  await core.stop();
});

type Host = ReturnType<typeof host>;

/** An agent host in a process of its own, as the shared daemon opens its stream: on the hub. */
function host(overrides: Partial<SwitchEventStreamDeps> = {}, as = token) {
  const seen = {
    events: [] as AgentBridgeEvent[],
    gaps: [] as Parameters<SwitchEventStreamDeps['onGap']>[0][],
    evictions: [] as Eviction[],
    commands: [] as SessionCommand[],
    outcomes: [] as ApprovalOutcome[],
    connected: 0,
    disconnected: [] as string[],
  };
  const controller = new AbortController();
  const stream: AgentEventStream = openHubStream(relay.hubUrl)({
    creds: { agentId: AGENT, apiEndpoint: relay.endpoint, token: as },
    connectionId: 'host-connection',
    worker: null,
    scope: 'all',
    filter: 'addressed',
    rooms: [],
    onEvent: (event) => void seen.events.push(event),
    onGap: (gap) => void seen.gaps.push(gap),
    onEvicted: (eviction) => void seen.evictions.push(eviction),
    onSessionCommand: (command) => void seen.commands.push(command),
    onApprovalOutcome: (outcome) => void seen.outcomes.push(outcome),
    onConnected: () => void seen.connected++,
    onDisconnected: ({ error }) => void seen.disconnected.push(error),
    log: quiet,
    signal: controller.signal,
    ...overrides,
  });
  stream.start();
  const stop = () => controller.abort();
  stops.push(stop);
  return { stream, seen, stop };
}

async function connected(agentHost: Host, times = 1): Promise<void> {
  await waitFor(() => agentHost.seen.connected >= times, 'the hub to say connected');
}

function caller(overrides: Partial<CallerContext> = {}, sessionId: string | null = 'session-1') {
  return {
    identity: { endpoint: relay.endpoint, agentId: AGENT, token },
    connectionId: 'host-connection',
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
    deadConnection: (operation: string) => `dead: ${operation}`,
    ...overrides,
  } satisfies CallerContext;
}

async function post(path: string, body: unknown, bearer = token): Promise<Response> {
  return fetch(`${relay.endpoint}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The status a WebSocket upgrade to the hub is answered with, as a raw client sees it. */
function upgradeStatus(bearer: string, path = '/hub'): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${relay.hubUrl.replace('/hub', path)}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    socket.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      socket.terminate();
    });
    socket.on('open', () => {
      resolve(101);
      socket.terminate();
    });
    socket.on('error', reject);
  });
}

describe('the hub, over the relay’s WebSocket, read by openHubStream', () => {
  it('serves the hub on the relay’s loopback port', () => {
    expect(relay.hubUrl).toBe(`${relay.endpoint.replace('http', 'ws')}/hub`);
  });

  it('connects, then delivers addressed events in order, each confirmed once handled', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const seen: number[] = [];
    const agentHost = host({
      onEvent: async (event) => {
        seen.push(event.sequence!);
        if (event.sequence === 4) await held;
      },
    });
    await connected(agentHost);
    hub.ingest(message(1, true));
    hub.ingest(message(2, false));
    hub.ingest(message(4, true));
    hub.ingest(message(5, true));
    await waitFor(() => seen.length === 2, 'the events up to the held one');
    // The event being handled is not confirmed, and the next is not sent.
    expect(seen).toEqual([1, 4]);
    expect(hub.cursors()[AGENT]).toBe(2);
    release();
    await waitFor(() => seen.length === 3, 'the event after the held one');
    expect(seen).toEqual([1, 4, 5]);
    await waitFor(() => hub.cursors()[AGENT] === 5, 'the cursor to move past it');
    expect(cursorsSaved.at(-1)).toEqual([AGENT, 5]);
  });

  it('tells the agent host when the controller loses and regains Switch', async () => {
    const agentHost = host();
    await connected(agentHost);
    hub.setUpstream(false);
    await waitFor(() => agentHost.seen.disconnected.length === 1, 'disconnected');
    expect(agentHost.seen.disconnected[0]).toMatch(/reconnecting to Switch/);
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a', 'room-b']);
    await connected(agentHost, 2);
  });

  it('tracks placements, names the session’s room on its calls, and routes room controls to it', async () => {
    const agentHost = host();
    await connected(agentHost);
    await agentHost.stream.replacePlacements({ 'session-1': 'room-a' });

    const placed = await callOperation(caller(), 'post_message', { body: 'hi' });
    expect(placed.isError).toBeFalsy();
    expect(placed.structuredContent).toMatchObject({ room_id: 'room-a' });
    const forwarded = core.requests.findLast((r) => r.path.endsWith('/ops/post_message'))!;
    expect(forwarded.headers['x-switch-room-id']).toBe('room-a');
    expect(forwarded.headers['x-switch-agent-id']).toBe(AGENT);
    expect(forwarded.headers['x-switch-session-id']).toBe('session-1');
    expect(forwarded.headers.authorization).toMatch(/^Bearer access-token-/);

    const unplaced = await callOperation(caller({}, 'session-9'), 'post_message', {});
    expect(unplaced.structuredContent).toMatchObject({ room_id: null });
    const bySoleRoom = await callOperation(caller({}, null), 'post_message', {});
    expect(bySoleRoom.structuredContent).toMatchObject({ room_id: 'room-a' });

    hub.sessionCommand({
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
    await waitFor(() => agentHost.seen.commands.length === 1, 'the room control');
    expect(agentHost.seen.commands[0]).toMatchObject({
      commandId: 'command-1',
      roomId: 'room-a',
      body: { type: 'session.reset' },
    });

    await expect(
      agentHost.stream.replacePlacements({ 'session-1': 'room-elsewhere' })
    ).rejects.toThrow(/not a member of room room-elsewhere/);
  });

  it('passes approval outcomes to the agent host', async () => {
    const agentHost = host();
    await connected(agentHost);
    hub.approvalOutcome({
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
    await waitFor(() => agentHost.seen.outcomes.length === 1, 'the outcome');
    expect(agentHost.seen.outcomes[0]).toMatchObject({ request_id: 'request-1', answer: 'yes' });
  });

  it('passes gaps through in order, and a reset as a cursor reset', async () => {
    const agentHost = host();
    await connected(agentHost);
    hub.ingest(message(1, true));
    await waitFor(() => agentHost.seen.events.length === 1, 'the first event');
    hub.gap({
      agent_id: AGENT,
      from_sequence: 1,
      resumed_at: 10,
      rooms: ['room-a'],
      all_rooms: false,
      reason: 'events older than the retention window were dropped',
    });
    hub.ingest(message(11, true));
    await waitFor(() => agentHost.seen.events.length === 2, 'the event after the gap');
    expect(agentHost.seen.gaps[0]).toMatchObject({ fromSequence: 1, resumedAt: 10 });
    hub.gap({
      agent_id: AGENT,
      from_sequence: 11,
      resumed_at: 2,
      rooms: [],
      all_rooms: true,
      reason: 'the server restarted',
    });
    await waitFor(() => agentHost.seen.gaps.length === 2, 'the reset');
    expect(agentHost.seen.gaps[1]).toMatchObject({ resumedAt: 2, cursorReset: true });
    hub.ingest(message(3, true));
    await waitFor(() => agentHost.seen.events.length === 3, 'numbering from the reset');
    await waitFor(() => hub.cursors()[AGENT] === 3, 'the cursor from the reset');
  });

  it('a handler that fails leaves the event unconfirmed', async () => {
    const agentHost = host({
      onEvent: (event) => {
        if (event.sequence === 2) throw new Error('the journal is full');
      },
    });
    await connected(agentHost);
    hub.ingest(message(1, true));
    hub.ingest(message(2, true));
    await waitFor(() => hub.cursors()[AGENT] === 1, 'the first event confirmed');
    await delay(100);
    expect(hub.cursors()[AGENT]).toBe(1);
  });

  it('reconnects when the controller restarts, resuming after what it handled', async () => {
    const agentHost = host();
    await connected(agentHost);
    hub.ingest(message(1, true));
    await waitFor(() => agentHost.seen.events.length === 1, 'the first event');
    const port = Number(new URL(relay.endpoint).port);
    await relay.close();
    await waitFor(() => agentHost.seen.disconnected.length >= 1, 'the restart close');

    // The controller comes back on the same port, its hub knowing nothing yet.
    hub = new AgentHub({
      log: silentLogger,
      bufferLimit: 100,
      onCursor: (agentId, cursor) => cursorsSaved.push([agentId, cursor]),
      onChange: () => {},
    });
    relay = newRelay();
    await relay.start(port);
    relay.register(AGENT, token);
    relay.setReady();
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a', 'room-b']);
    await connected(agentHost, 2);
    // Switch replays from the opened cursor; the agent host said where it was.
    hub.ingest(message(1, true));
    hub.ingest(message(2, true));
    await waitFor(() => agentHost.seen.events.length === 2, 'the new event');
    expect(agentHost.seen.events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it('a second agent host for the agent takes the hub over, and the first stands down', async () => {
    const first = host();
    await connected(first);
    const second = host();
    await connected(second);
    await waitFor(() => first.seen.evictions.length === 1, 'the first to be evicted');
    expect(first.seen.evictions[0]).toMatchObject({ code: 'taken_over' });
    hub.ingest(message(1, true));
    await waitFor(() => second.seen.events.length === 1, 'the event at the second');
    await delay(50);
    expect(first.seen.events).toEqual([]);
  });
});

describe('what the relay refuses', () => {
  it('binds to loopback only', () => {
    expect(relay.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('refuses a token it did not mint with 401, and asks to retry while starting', async () => {
    const refused = await post(`/agents/${AGENT}/ops/post_message`, {}, 'swlr_not-a-token');
    expect(refused.status).toBe(401);
    expect(await upgradeStatus('swlr_not-a-token')).toBe(401);
    expect(await upgradeStatus(token)).toBe(101);
    expect(await upgradeStatus(token, '/elsewhere')).toBe(404);
    const starting = newRelay();
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

  it('answers the agent connection routes of an agent host from before the hub with 410', async () => {
    for (const path of [`/agents/${AGENT}/connection/beat`, `/agents/${AGENT}/events`]) {
      const response = await fetch(`${relay.endpoint}${path}`, {
        method: path.endsWith('beat') ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status, path).toBe(410);
      expect(JSON.stringify(await response.json())).toMatch(/\/hub/);
    }
    expect(core.requests.filter((r) => r.path.includes('/connection/'))).toEqual([]);
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
    expect(forwarded.headers['switch-controller-protocol']).toBe('2');
    expect(forwarded.body).toEqual({ row: 1 });
  });

  it('names the room of a call from its session’s placement on the hub', async () => {
    // An agent host in the controller's own process states its placements to the hub directly.
    hub.attach('agent-2', 0, ['room-shared']);
    const inProcess = new AbortController();
    stops.push(() => inProcess.abort());
    await hub
      .open('agent-2', {
        creds: { agentId: 'agent-2', apiEndpoint: '', token: '' },
        connectionId: 'in-process',
        worker: null,
        scope: 'all',
        filter: 'addressed',
        rooms: [],
        onEvent: () => {},
        onGap: () => {},
        onEvicted: () => {},
        log: quiet,
        signal: inProcess.signal,
      })
      .replacePlacements({ 'session-7': 'room-shared' });
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
