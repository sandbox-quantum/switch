import { setTimeout as delay } from 'node:timers/promises';
import type {
  AgentBridgeEvent,
  ApprovalOutcome,
  SessionCommand,
  SwitchEventStreamDeps,
} from '@sandboxaq/switch-agent-runtime-box';
import type { AgentStreamDeps } from '@switch-console/agent-providers-box';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => {
  saved = [];
  changes = 0;
  hub = new AgentHub({
    log: silentLogger,
    onCursor: (agentId, cursor) => saved.push([agentId, cursor]),
    onChange: () => changes++,
    bufferLimit: 5,
  });
});

/** A watcher as `runAgentHost` opens its stream, recording what it hears. */
function watcher(overrides: Partial<AgentStreamDeps> = {}) {
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

  it("hands a new agent's first watcher what arrived while it was starting", async () => {
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    // A template's kickoff, posted the moment the agent exists, before its
    // host is up and with no cursor of its own.
    hub.ingest(message(1, true));
    const { stream, seen } = watcher();
    stream.start();
    await waitFor(() => seen.events.length === 1, 'the kickoff');
    expect(seen.events[0]!.sequence).toBe(1);
    expect(seen.gaps).toEqual([]);
  });

  it('starts a later watcher with no cursor where the last one got to, not past what arrived between', async () => {
    // Changed in review: starting it at the newest event skipped
    // event 2, which arrived while no host ran (a crash, a restart, a rest).
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    const first = watcher();
    first.stream.start();
    hub.ingest(message(1, true));
    await waitFor(() => first.seen.events.length === 1, 'the first event');
    first.stop();
    hub.ingest(message(2, true));
    const second = watcher();
    second.stream.start();
    hub.ingest(message(3, true));
    await waitFor(() => second.seen.events.length === 2, 'what arrived between, and after');
    expect(second.seen.events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(second.seen.gaps).toEqual([]);
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

  it('places the sessions in rooms the agent is in, leaving out and naming one that is gone, every time', async () => {
    const warn = vi.spyOn(silentLogger, 'warn');
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    const { stream } = watcher();
    stream.start();
    for (let i = 0; i < 3; i++) {
      // A session left placed in a room since deleted, beside one in a live room.
      await expect(
        stream.replacePlacements({ 'session-old': 'room-deleted', 'session-1': 'room-a' })
      ).resolves.toEqual({ refusedRooms: ['room-deleted'] });
      // The live session's room tools carry its room.
      expect(hub.roomFor(AGENT, 'session-1')).toBe('room-a');
      expect(hub.roomFor(AGENT, 'session-old')).toBeNull();
    }
    // Said once for the room, not on every statement.
    expect(warn.mock.calls.filter(([message]) => String(message).includes('not in'))).toHaveLength(
      1
    );
    warn.mockRestore();
  });

  it('tells the agent host when a room a session is placed in stops being the agent’s', async () => {
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a', 'room-b']);
    const gone: { roomId: string; sessionId: string }[] = [];
    const { stream } = watcher({ onRoomGone: (info) => void gone.push(info) });
    stream.start();
    await stream.replacePlacements({ 'session-1': 'room-a', 'session-2': 'room-b' });
    // The chat in room-b was deleted: Switch's rooms for the agent no longer have it.
    hub.setRooms(AGENT, ['room-a']);
    expect(gone).toEqual([{ roomId: 'room-b', sessionId: 'session-2' }]);
    expect(hub.roomFor(AGENT, 'session-2')).toBeNull();
    expect(hub.roomFor(AGENT, 'session-1')).toBe('room-a');
  });

  it('refuses placements from an agent host a newer one replaced, rather than dropping them', async () => {
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    const older = watcher();
    older.stream.start();
    const newer = watcher();
    newer.stream.start();
    await expect(older.stream.replacePlacements({ 'session-1': 'room-a' })).rejects.toThrow(
      /a newer one does/
    );
    expect(hub.roomFor(AGENT, 'session-1')).toBeNull();
  });

  it('refuses one room for two sessions', async () => {
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    const { stream } = watcher();
    stream.start();
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

  describe('a reset Switch left the box to announce', () => {
    const reset = (commandId: string) => ({
      agent_id: AGENT,
      room_id: 'room-a',
      command: {
        commandId,
        sessionId: null,
        roomTold: false,
        body: { type: 'session.reset' },
        origin: { roomId: 'room-a', threadId: 'thread-1' },
      },
    });
    const refusing = () => {
      const refused: { agentId: string; notice: unknown }[] = [];
      hub = new AgentHub({
        log: silentLogger,
        onCursor: () => {},
        onChange: () => {},
        bufferLimit: 5,
        resetRefused: async (agentId, notice) => void refused.push({ agentId, notice }),
      });
      hub.streamAttached();
      hub.attach(AGENT, 0, ['room-a', 'room-b']);
      return refused;
    };

    it('has Switch tell the room it could not be done when no agent host runs', async () => {
      const refused = refusing();
      hub.sessionCommand(reset('reset-1'));
      await waitFor(() => refused.length === 1, 'the refusal');
      expect(refused).toEqual([
        {
          agentId: AGENT,
          notice: { roomId: 'room-a', threadId: 'thread-1', commandId: 'reset-1' },
        },
      ]);
    });

    it('has Switch tell the room when no session of the agent works there, and does not pass it on', async () => {
      const refused = refusing();
      const { stream, seen } = watcher();
      stream.start();
      await stream.replacePlacements({ 'session-1': 'room-b' });
      hub.sessionCommand(reset('reset-2'));
      await waitFor(() => refused.length === 1, 'the refusal');
      await delay(20);
      expect(seen.commands).toEqual([]);
    });

    it('passes it to the agent host when a session works in the room, even a resting one', async () => {
      const refused = refusing();
      const { stream, seen } = watcher();
      stream.start();
      await stream.replacePlacements({ 'session-1': 'room-a' });
      hub.sessionCommand(reset('reset-3'));
      await waitFor(() => seen.commands.length === 1, 'the reset');
      expect(refused).toEqual([]);
    });

    it('leaves a reset Switch announced, and other controls, as they were', async () => {
      const refused = refusing();
      hub.sessionCommand({
        ...reset('reset-4'),
        command: { ...reset('reset-4').command, roomTold: undefined },
      });
      hub.sessionCommand({
        ...reset('compact-1'),
        command: { ...reset('compact-1').command, body: { type: 'session.compact' } },
      });
      await delay(20);
      expect(refused).toEqual([]);
    });
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

describe('an agent suspended until its next message', () => {
  let wakes: string[];

  beforeEach(() => {
    wakes = [];
    hub = new AgentHub({
      log: silentLogger,
      onCursor: (agentId, cursor) => saved.push([agentId, cursor]),
      onChange: () => changes++,
      bufferLimit: 5,
      onWake: (_agentId, why) => void wakes.push(why),
    });
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
  });

  it('asks to wake for an addressed event, but not for chatter, and only while suspended', () => {
    hub.ingest(message(1, true));
    expect(wakes).toEqual([]);
    hub.setSuspended(AGENT, true);
    // What was already held when it was suspended is owed a start.
    expect(wakes).toEqual(['event']);
    hub.ingest(message(2, false));
    expect(wakes).toEqual(['event']);
    hub.ingest(message(3, true));
    expect(wakes).toEqual(['event', 'event']);
    hub.setSuspended(AGENT, false);
    hub.ingest(message(4, true));
    expect(wakes).toEqual(['event', 'event']);
  });

  it('keeps a room control for its next agent host, asks to wake, and hands it over once connected', async () => {
    hub.setSuspended(AGENT, true);
    hub.sessionCommand({
      agent_id: AGENT,
      room_id: 'room-a',
      command: { commandId: 'reset-1', sessionId: null, body: { type: 'session.reset' } },
    });
    expect(wakes).toEqual(['room_control']);
    expect(hub.waiting(AGENT)).toBe(true);
    hub.setSuspended(AGENT, false);
    const { stream, seen } = watcher();
    stream.start();
    await waitFor(() => seen.commands.length === 1, 'the kept room control');
    expect(seen.commands[0]).toMatchObject({ commandId: 'reset-1', roomId: 'room-a' });
    expect(hub.waiting(AGENT)).toBe(false);
  });

  it('drops a room control with no agent host when the agent is not suspended, as before', () => {
    hub.sessionCommand({
      agent_id: AGENT,
      room_id: 'room-a',
      command: { commandId: 'reset-1', sessionId: null },
    });
    expect(wakes).toEqual([]);
    expect(hub.waiting(AGENT)).toBe(false);
  });

  it('hands a held agent host nothing more until released, and keeps the cursor behind what it holds', async () => {
    const { stream, seen } = watcher();
    stream.start();
    hub.ingest(message(1, true));
    await waitFor(() => seen.events.length === 1, 'the first event');
    await hub.hold(AGENT);
    hub.ingest(message(2, true));
    await delay(20);
    expect(seen.events.map((event) => event.sequence)).toEqual([1]);
    expect(hub.cursors()).toEqual({ [AGENT]: 1 });
    expect(hub.waiting(AGENT)).toBe(true);
    hub.release(AGENT);
    await waitFor(() => seen.events.length === 2, 'the event held meanwhile');
    expect(hub.waiting(AGENT)).toBe(false);
  });

  it('waits out the event being handed over when held', async () => {
    let finish: () => void = () => {};
    const { stream, seen } = watcher({
      onEvent: (event) =>
        new Promise<void>((resolve) => {
          seen.events.push(event);
          finish = resolve;
        }),
    });
    stream.start();
    hub.ingest(message(1, true));
    await waitFor(() => seen.events.length === 1, 'the event being taken');
    let held = false;
    const holding = hub.hold(AGENT).then(() => (held = true));
    await delay(20);
    expect(held).toBe(false);
    finish();
    await holding;
    expect(hub.cursors()).toEqual({ [AGENT]: 1 });
  });

  it('records when its agent host last took an addressed event, not chatter', async () => {
    let clock = 1_000;
    hub = new AgentHub({
      log: silentLogger,
      onCursor: () => {},
      onChange: () => {},
      bufferLimit: 5,
      now: () => clock,
    });
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    const { stream } = watcher();
    stream.start();
    expect(hub.lastAddressedAt(AGENT)).toBeNull();
    hub.ingest(message(1, true));
    await waitFor(() => hub.lastAddressedAt(AGENT) === 1_000, 'the addressed event taken');
    clock = 5_000;
    hub.ingest(message(2, false));
    await delay(20);
    expect(hub.lastAddressedAt(AGENT)).toBe(1_000);
  });

  it('hands the next agent host what arrived after Core restarted while the agent rested', async () => {
    // Fails without the fix: the host, holding a cursor from before the
    // restart, started at the newest event and skipped the ones since.
    const first = watcher();
    first.stream.start();
    for (const seq of [1, 2, 3]) hub.ingest(message(seq, true));
    await waitFor(() => first.seen.events.length === 3, 'the first three');
    first.stop();
    hub.setSuspended(AGENT, true);
    hub.gap({
      agent_id: AGENT,
      from_sequence: 3,
      resumed_at: 0,
      all_rooms: true,
      rooms: ['room-a'],
      reason: 'switch restarted',
    });
    hub.ingest(message(1, true));
    hub.ingest(message(2, true));
    expect(wakes).toEqual(['event', 'event']);
    hub.setSuspended(AGENT, false);
    // Its own journal still says 3, from the old numbering.
    const second = watcher({ startCursor: 3 });
    second.stream.start();
    await waitFor(() => second.seen.events.length === 2, 'both events since the restart');
    expect(second.seen.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(second.seen.gaps).toEqual([
      expect.objectContaining({ resumedAt: 0, cursorReset: true }),
    ]);
  });

  it('keeps only the latest room control of each kind per room', async () => {
    hub.setSuspended(AGENT, true);
    const reset = (commandId: string, room = 'room-a') =>
      hub.sessionCommand({
        agent_id: AGENT,
        room_id: room,
        command: { commandId, sessionId: null, body: { type: 'session.reset' } },
      });
    reset('reset-1');
    reset('reset-2');
    reset('reset-3', 'room-b');
    hub.sessionCommand({
      agent_id: AGENT,
      room_id: 'room-a',
      command: { commandId: 'compact-1', sessionId: null, body: { type: 'session.compact' } },
    });
    hub.setSuspended(AGENT, false);
    hub.attach(AGENT, 0, ['room-a', 'room-b']);
    const { stream, seen } = watcher();
    stream.start();
    await waitFor(() => seen.commands.length === 3, 'the kept room controls');
    await delay(20);
    expect(seen.commands.map((command) => command.commandId)).toEqual([
      'reset-2',
      'reset-3',
      'compact-1',
    ]);
  });

  it('drops a room control kept longer than ten minutes, rather than run it on a late start', async () => {
    let clock = 0;
    hub = new AgentHub({
      log: silentLogger,
      onCursor: () => {},
      onChange: () => {},
      bufferLimit: 5,
      onWake: () => {},
      now: () => clock,
    });
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    hub.setSuspended(AGENT, true);
    hub.sessionCommand({
      agent_id: AGENT,
      room_id: 'room-a',
      command: { commandId: 'reset-1', sessionId: null, body: { type: 'session.reset' } },
    });
    expect(hub.waiting(AGENT)).toBe(true);
    clock = 10 * 60_000;
    expect(hub.waiting(AGENT)).toBe(false);
    hub.setSuspended(AGENT, false);
    const { stream, seen } = watcher();
    stream.start();
    await delay(20);
    expect(seen.commands).toEqual([]);
  });

  it('drops the room controls it kept when unsuspended to be forgotten (an owner stop, a removal)', async () => {
    hub.setSuspended(AGENT, true);
    hub.sessionCommand({
      agent_id: AGENT,
      room_id: 'room-a',
      command: { commandId: 'reset-1', sessionId: null, body: { type: 'session.reset' } },
    });
    hub.setSuspended(AGENT, false, { drop: true });
    expect(hub.waiting(AGENT)).toBe(false);
    const { stream, seen } = watcher();
    stream.start();
    await delay(20);
    expect(seen.commands).toEqual([]);
  });

  it('tells of each kept room control that will not reach a host, but not one a newer replaced', () => {
    const dropped: string[] = [];
    let clock = 0;
    hub = new AgentHub({
      log: silentLogger,
      onCursor: () => {},
      onChange: () => {},
      bufferLimit: 5,
      onHeldCommandDropped: (_agentId, roomId, command) =>
        void dropped.push(`${roomId}:${command.commandId}`),
      now: () => clock,
    });
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a', 'room-b']);
    hub.setSuspended(AGENT, true);
    const reset = (commandId: string, room: string) =>
      hub.sessionCommand({
        agent_id: AGENT,
        room_id: room,
        command: { commandId, sessionId: null, body: { type: 'session.reset' } },
      });
    reset('reset-1', 'room-a');
    reset('reset-2', 'room-a');
    expect(dropped).toEqual([]);
    clock = 10 * 60_000;
    reset('reset-3', 'room-b');
    expect(dropped).toEqual(['room-a:reset-2']);
    hub.setSuspended(AGENT, false, { drop: true });
    expect(dropped).toEqual(['room-a:reset-2', 'room-b:reset-3']);
  });

  it("answers a kept reset that won't reach a host with the couldn't-reset line, as wired in the controller", async () => {
    const refused: string[] = [];
    let clock = 0;
    const wired: AgentHub = new AgentHub({
      log: silentLogger,
      onCursor: () => {},
      onChange: () => {},
      bufferLimit: 5,
      now: () => clock,
      resetRefused: async (_agentId, notice) =>
        void refused.push(`${notice.roomId}:${notice.threadId}:${notice.commandId}`),
      onHeldCommandDropped: (agentId, roomId, command) =>
        wired.refuseReset(agentId, roomId, command),
    });
    hub = wired;
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    hub.setSuspended(AGENT, true);
    hub.sessionCommand({
      agent_id: AGENT,
      room_id: 'room-a',
      command: {
        commandId: 'reset-1',
        sessionId: null,
        roomTold: false,
        body: { type: 'session.reset' },
        origin: { roomId: 'room-a', threadId: 'thread-1' },
      },
    });
    // An interrupt kept and dropped the same way gets no line: only resets do.
    hub.sessionCommand({
      agent_id: AGENT,
      room_id: 'room-a',
      command: { commandId: 'stop-1', sessionId: null, body: { type: 'turn.interrupt' } },
    });
    clock = 11 * 60_000;
    hub.setSuspended(AGENT, false, { drop: true });
    await waitFor(() => refused.length === 1, 'the refusal');
    await delay(20);
    expect(refused).toEqual(['room-a:thread-1:reset-1']);
  });

  it('asks to wake a suspended agent for a gap, which must reach a host in order', () => {
    hub.setSuspended(AGENT, true);
    hub.gap({ agent_id: AGENT, from_sequence: 0, resumed_at: 4, reason: 'lost' });
    expect(wakes).toEqual(['event']);
  });

  it('gives up waiting on an event being handed over after the time allowed, keeping the fence', async () => {
    const { stream, seen } = watcher({ onEvent: () => new Promise<void>(() => {}) });
    stream.start();
    hub.ingest(message(1, true));
    await waitFor(() => changes >= 0 && hub.attached(AGENT), 'the host connected');
    await delay(10);
    expect(await hub.hold(AGENT, 30)).toBe(false);
    hub.ingest(message(2, true));
    await delay(20);
    expect(seen.events).toEqual([]);
    expect(hub.cursors()).toEqual({});
  });

  it('says when its agent host has taken an addressed event, and not for chatter', async () => {
    const taken: number[] = [];
    hub = new AgentHub({
      log: silentLogger,
      onCursor: () => {},
      onChange: () => {},
      bufferLimit: 5,
      onAddressedTaken: (_agentId, event) => void taken.push(event.sequence ?? -1),
    });
    hub.streamAttached();
    hub.attach(AGENT, 0, ['room-a']);
    const { stream } = watcher();
    stream.start();
    hub.ingest(message(1, false));
    hub.ingest(message(2, true));
    await waitFor(() => taken.length === 1, 'the addressed event taken');
    expect(taken).toEqual([2]);
  });

  it('says Switch carries the agent while the stream is up, host or not', () => {
    expect(hub.attached(AGENT)).toBe(false);
    expect(hub.streamCarries(AGENT)).toBe(true);
    hub.setUpstream(false);
    expect(hub.streamCarries(AGENT)).toBe(false);
  });
});
