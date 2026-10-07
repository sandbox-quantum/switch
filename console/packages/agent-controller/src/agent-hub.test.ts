import { setTimeout as delay } from 'node:timers/promises';
import type {
  AgentBridgeEvent,
  ApprovalOutcome,
  SessionCommand,
  SwitchEventStreamDeps,
} from '@sandboxaq/switch-agent-runtime';
import {
  type ControlContext,
  type ControlPush,
  WatcherControl,
} from '@switch-console/agent-providers';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentHub } from './agent-hub';
import { silentLogger } from './log';
import type { AgentEventFrame } from './schemas';

const AGENT = 'agent-1';

function message(seq: number, addressed: boolean, room = 'room-a'): AgentEventFrame {
  return {
    agent_id: AGENT,
    seq,
    event: {
      type: 'message',
      room_id: room,
      payload: { addressed, message_id: `$m${seq}`, body: `hello ${seq}` },
    },
  };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(5);
  }
}

let hub: AgentHub;
let saved: [string, number][];
let changes: number;
let pushed: [string, ControlPush][];
let controlChanges: string[];

beforeEach(() => {
  saved = [];
  changes = 0;
  pushed = [];
  controlChanges = [];
  hub = new AgentHub({
    log: silentLogger,
    onCursor: (agentId, cursor) => saved.push([agentId, cursor]),
    onChange: () => changes++,
    bufferLimit: 5,
    onControlPush: (agentId, push) => pushed.push([agentId, push]),
    onControlChange: (agentId) => controlChanges.push(agentId),
  });
});

describe('relayed control messages', () => {
  function context(watcher: WatcherControl): ControlContext {
    return {
      agentId: AGENT,
      links: {} as ControlContext['links'],
      ensure: async () => null,
      watcher,
      transfers: {} as ControlContext['transfers'],
    };
  }

  it('answers through the agent host registered for the agent, and pushes its live views', async () => {
    await expect(hub.control(AGENT, { health: true }, () => {})).rejects.toMatchObject({
      code: 'agent_not_running',
    });
    const watcher = new WatcherControl();
    const detach = hub.attachControl(AGENT, context(watcher));
    expect(hub.controlAttached(AGENT)).toBe(true);
    expect(controlChanges).toEqual([AGENT]);
    expect(await hub.control(AGENT, { health: true }, () => {})).toMatchObject({
      state: 'not-running',
    });
    await hub.control(AGENT, { watchHealth: true }, () => {});
    watcher.report({ state: 'connected' });
    expect(pushed).toEqual([[AGENT, { health: expect.objectContaining({ state: 'connected' }) }]]);
    detach();
    expect(hub.controlAttached(AGENT)).toBe(false);
    expect(controlChanges).toEqual([AGENT, AGENT]);
    watcher.report({ state: 'disconnected' });
    expect(pushed).toHaveLength(1);
  });

  it('withdraws the registration when the agent is forgotten', () => {
    const detach = hub.attachControl(AGENT, context(new WatcherControl()));
    hub.forget(AGENT);
    expect(hub.controlAttached(AGENT)).toBe(false);
    detach();
    expect(controlChanges).toEqual([AGENT, AGENT]);
  });
});

/** A watcher as `runAgentHost` opens its stream, recording what it hears. */
function watcher(overrides: Partial<SwitchEventStreamDeps> = {}) {
  const seen = {
    events: [] as AgentBridgeEvent[],
    gaps: [] as Parameters<SwitchEventStreamDeps['onGap']>[0][],
    commands: [] as SessionCommand[],
    outcomes: [] as ApprovalOutcome[],
    connected: 0,
    disconnected: [] as string[],
  };
  const controller = new AbortController();
  const stream = hub.open(AGENT, {
    creds: { agentId: AGENT, apiEndpoint: 'http://127.0.0.1:1', token: 'swlr_x' },
    connectionId: 'connection-1',
    worker: null,
    scope: 'all',
    filter: 'addressed',
    spawnCapable: true,
    rooms: [],
    onEvent: (event) => void seen.events.push(event),
    onGap: (gap) => void seen.gaps.push(gap),
    onEvicted: () => {},
    onSessionCommand: (command) => void seen.commands.push(command),
    onApprovalOutcome: (outcome) => void seen.outcomes.push(outcome),
    onConnected: () => void seen.connected++,
    onDisconnected: ({ error }) => void seen.disconnected.push(error),
    log: { debug: () => {}, warn: () => {}, error: () => {} },
    signal: controller.signal,
    ...overrides,
  });
  return { stream, seen, stop: () => controller.abort() };
}

describe('handing events to the watcher', () => {
  it('connects once the agent is attached, then hands over addressed events in order and confirms each', async () => {
    const { stream, seen } = watcher();
    stream.start();
    expect(seen.connected).toBe(0);
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    expect(seen.connected).toBe(1);
    expect(hub.attached(AGENT)).toBe(true);
    hub.ingest(message(1, true));
    hub.ingest(message(2, false));
    hub.ingest(message(3, true));
    await waitFor(() => saved.length === 3, 'every event confirmed');
    expect(seen.events.map((event) => event.sequence)).toEqual([1, 3]);
    expect(seen.events[0]).toMatchObject({ type: 'message', room_id: 'room-a' });
    expect(saved).toEqual([
      [AGENT, 1],
      [AGENT, 2],
      [AGENT, 3],
    ]);
    expect(hub.cursors()).toEqual({ [AGENT]: 3 });
  });

  it('confirms an event only once the watcher has taken it', async () => {
    let release: () => void = () => {};
    const taken = new Promise<void>((resolve) => (release = resolve));
    const { stream } = watcher({ onEvent: () => taken });
    stream.start();
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    hub.ingest(message(1, true));
    await delay(20);
    expect(saved).toEqual([]);
    release();
    await waitFor(() => saved.length === 1, 'the event confirmed');
  });

  it('holds events while no watcher runs, and hands them over from its own cursor when it starts', async () => {
    hub.setCursor(AGENT, 2);
    hub.streamAttached();
    hub.attach(AGENT, 2, ['room-a']);
    hub.ingest(message(3, true));
    hub.ingest(message(4, true));
    expect(hub.attached(AGENT)).toBe(false);
    const { stream, seen } = watcher({ startCursor: 3 });
    stream.start();
    await waitFor(() => seen.events.length === 1, 'the event past its cursor');
    expect(seen.events[0]!.sequence).toBe(4);
    expect(seen.connected).toBe(1);
  });

  it('tells a watcher starting from before what is held that it missed events', async () => {
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    for (let seq = 1; seq <= 8; seq++) hub.ingest(message(seq, true));
    const { stream, seen } = watcher({ startCursor: 0 });
    stream.start();
    await waitFor(() => seen.events.length === 5, 'the five events still held');
    expect(seen.gaps).toEqual([
      expect.objectContaining({ fromSequence: 0, resumedAt: 3, cursorReset: false }),
    ]);
    expect(seen.events.map((event) => event.sequence)).toEqual([4, 5, 6, 7, 8]);
  });

  it('drops what a reattached stream replays, and a gap behind what it holds', async () => {
    const { stream, seen } = watcher();
    stream.start();
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    hub.ingest(message(1, true));
    hub.ingest(message(2, true));
    await waitFor(() => seen.events.length === 2, 'both events');
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    hub.ingest(message(1, true));
    hub.ingest(message(2, true));
    hub.gap({ agent_id: AGENT, from_sequence: 0, resumed_at: 1, reason: 'replayed' });
    hub.ingest(message(3, true));
    await waitFor(() => seen.events.length === 3, 'the new event');
    expect(seen.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(seen.gaps).toEqual([]);
  });

  it('passes a gap ahead of what it holds in order, and a reset as a cursor reset', async () => {
    const { stream, seen } = watcher();
    stream.start();
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    hub.ingest(message(1, true));
    hub.gap({ agent_id: AGENT, from_sequence: 1, resumed_at: 4, reason: 'lost' });
    hub.ingest(message(5, true));
    await waitFor(() => seen.events.length === 2, 'the event after the gap');
    expect(seen.gaps).toEqual([
      expect.objectContaining({ fromSequence: 1, resumedAt: 4, reason: 'lost' }),
    ]);

    hub.gap({
      agent_id: AGENT,
      from_sequence: 5,
      resumed_at: 2,
      all_rooms: true,
      rooms: ['room-a'],
      reason: 'switch restarted',
    });
    await waitFor(() => seen.gaps.length === 2, 'the reset');
    expect(seen.gaps[1]).toMatchObject({ resumedAt: 2, cursorReset: true });
    expect(saved.at(-1)).toEqual([AGENT, 2]);
    hub.ingest(message(3, true));
    await waitFor(() => seen.events.length === 3, 'the event after the reset');
    expect(seen.events.at(-1)!.sequence).toBe(3);
  });
});

describe('the connection', () => {
  it('tells the watcher when Switch detaches the agent or the controller stream drops, and when it is back', () => {
    const { stream, seen } = watcher();
    stream.start();
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    hub.detach(AGENT, 'unassigned');
    expect(seen.disconnected).toEqual(['Switch detached the agent from this controller.']);
    hub.attach(AGENT, 0, ['room-a']);
    hub.setUpstream(false);
    expect(seen.disconnected.at(-1)).toBe('The controller is reconnecting to Switch.');
    expect(hub.attached(AGENT)).toBe(false);
    hub.streamAttached();
    expect(hub.attached(AGENT)).toBe(false);
    hub.attach(AGENT, 0, ['room-a']);
    expect(seen.connected).toBe(3);
  });

  it('hears nothing more once replaced by a newer watcher of the agent, or once stopped', async () => {
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    const first = watcher();
    first.stream.start();
    const second = watcher();
    second.stream.start();
    hub.ingest(message(1, true));
    await waitFor(() => second.seen.events.length === 1, 'the newer watcher');
    expect(first.seen.events).toEqual([]);
    second.stop();
    hub.ingest(message(2, true));
    await delay(20);
    expect(second.seen.events).toHaveLength(1);
    expect(hub.attached(AGENT)).toBe(false);
  });
});

describe('placements', () => {
  it('names a session’s room from its agent host, and forgets it when the agent host stops', async () => {
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a', 'room-b']);
    const { stream, stop } = watcher();
    stream.start();
    await stream.replacePlacements({ 'session-1': 'room-b', 'session-2': 'room-a' });
    expect(hub.roomFor(AGENT, 'session-1')).toBe('room-b');
    expect(hub.roomFor(AGENT, 'session-9')).toBeNull();
    expect(hub.roomFor(AGENT, null)).toBeNull();
    await stream.replacePlacements({ 'session-1': 'room-b' });
    expect(hub.roomFor(AGENT, null)).toBe('room-b');
    expect(changes).toBeGreaterThan(0);
    stop();
    expect(hub.roomFor(AGENT, 'session-1')).toBeNull();
  });

  it('refuses a room the agent is not in, and one room for two sessions', async () => {
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    const { stream } = watcher();
    stream.start();
    await expect(stream.replacePlacements({ 'session-1': 'room-z' })).rejects.toThrow(
      /not a member of room room-z/
    );
    await expect(
      stream.replacePlacements({ 'session-1': 'room-a', 'session-2': 'room-a' })
    ).rejects.toThrow(/more than one session/);
  });
});

describe('room controls and approvals', () => {
  it('hands a room control to the agent host with its room, for it to pick the session', async () => {
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a', 'room-b']);
    const { stream, seen } = watcher();
    stream.start();
    hub.sessionCommand({
      agent_id: AGENT,
      room_id: 'room-a',
      command: { commandId: 'command-1', sessionId: null, body: { type: 'session.reset' } },
    });
    hub.sessionCommand({
      agent_id: AGENT,
      room_id: null,
      command: { commandId: 'command-2', origin: { roomId: 'room-b' } },
    });
    hub.sessionCommand({ agent_id: AGENT, room_id: null, command: { commandId: 'command-3' } });
    await waitFor(() => seen.commands.length === 2, 'both room controls');
    await delay(20);
    expect(seen.commands).toEqual([
      expect.objectContaining({ commandId: 'command-1', sessionId: null, roomId: 'room-a' }),
      expect.objectContaining({ commandId: 'command-2', sessionId: null, roomId: 'room-b' }),
    ]);
  });

  it('passes approval outcomes to the running agent host', async () => {
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    hub.approvalOutcome({
      agent_id: AGENT,
      outcome: { session_id: 's', request_id: 'r0', state: 'answered' },
    });
    const { stream, seen } = watcher();
    stream.start();
    hub.approvalOutcome({
      agent_id: AGENT,
      outcome: { session_id: 's', request_id: 'r1', state: 'answered', answer: 'yes' },
    });
    await waitFor(() => seen.outcomes.length === 1, 'the outcome');
    expect(seen.outcomes[0]).toEqual({
      session_id: 's',
      request_id: 'r1',
      state: 'answered',
      answer: 'yes',
      answered_by: null,
      answered_at: null,
    });
  });
});
