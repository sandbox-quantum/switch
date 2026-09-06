import { describe, expect, it, vi } from 'vitest';
import { startMultiRoomAgent, systemClock, type OpenStream } from './agent';
import type { Turn } from './host';
import { MAX_TIMER_MS, serialiseWakeups } from './schedule';

/**
 * The two halves joined: a `multi` stream on one side, the host on the other.
 *
 * Everything either side does is already tested. What is not, until here, is
 * that they are actually connected — and the failure mode of a missing wire is
 * silence, which is indistinguishable from a quiet room. Each of the stream's
 * four callbacks has a counterpart, and `onEvicted` was the one the host did not
 * have when it was written.
 */

const CREDS = { agentId: 'agent-1', apiEndpoint: 'https://switch.test/api', token: 'tok' };
const ROOM_A = '!a:switch.local';
const ROOM_B = '!b:switch.local';
const SILENT = { debug() {}, warn() {}, error() {} };

type Handlers = Parameters<OpenStream>[0];

function harness(rooms = [ROOM_A, ROOM_B]) {
  const turns: Turn[] = [];
  let captured!: Handlers;
  let started = 0;

  const openStream: OpenStream = (handlers) => {
    captured = handlers;
    return {
      start() {
        started += 1;
      },
    };
  };

  const agent = startMultiRoomAgent({
    creds: CREDS,
    connectionId: 'conn-1',
    rooms,
    log: SILENT,
    loadSchedule: async () => serialiseWakeups([]),
    saveSchedule: async () => {},
    onTurn: async (turn) => {
      turns.push(turn);
    },
    openStream,
  });

  return {
    agent,
    turns,
    stream: () => captured,
    startCount: () => started,
  };
}

function message(roomId: string, body: string) {
  return {
    type: 'message',
    room_id: roomId,
    payload: { addressed: true, sender: '@u:s', sender_name: 'u', message_id: `$${body}`, body },
  } as never;
}

describe('starting a multi-room agent', () => {
  it('opens the stream as `multi`, over the declared rooms', async () => {
    const { agent, stream, startCount } = harness();
    await agent.ready;

    expect(stream().scope).toBe('multi');
    expect(stream().rooms).toEqual([ROOM_A, ROOM_B]);
    expect(startCount()).toBe(1);

    await agent.stop();
  });

  it('does not open the stream before the schedule has been read', async () => {
    /**
     * Events begin arriving the moment the socket does. Opening first means the
     * first turn can run against an empty schedule and then have it replaced
     * underneath, which reads as a wake-up that silently went missing.
     */
    let resolveLoad!: (text: string) => void;
    const loaded = new Promise<string>((resolve) => {
      resolveLoad = resolve;
    });
    let opened = false;

    const agent = startMultiRoomAgent({
      creds: CREDS,
      connectionId: 'conn-1',
      rooms: [ROOM_A],
      log: SILENT,
      loadSchedule: () => loaded,
      saveSchedule: async () => {},
      onTurn: async () => {},
      openStream: () => {
        opened = true;
        return { start() {} };
      },
    });

    expect(opened).toBe(false);
    resolveLoad(serialiseWakeups([]));
    await agent.ready;
    expect(opened).toBe(true);

    await agent.stop();
  });
});

describe('the four wires', () => {
  it('an event becomes a turn in the room it came from', async () => {
    const { agent, turns, stream } = harness();
    await agent.ready;

    await stream().onEvent(message(ROOM_B, 'hello'));

    expect(turns).toHaveLength(1);
    expect(turns[0].roomId).toBe(ROOM_B);

    await agent.stop();
  });

  it('the server’s room list becomes the host’s', async () => {
    const { agent, stream } = harness();
    await agent.ready;

    stream().onRooms?.([ROOM_A]);

    expect(agent.host.rooms).toEqual([ROOM_A]);

    await agent.stop();
  });

  it('a gap marks the next turn, and says how far back it goes', async () => {
    /** `fromSequence` is the only thing that tells the agent how much to
     * re-read; dropping it leaves "something was lost, somewhere". */
    const { agent, turns, stream } = harness();
    await agent.ready;

    stream().onGap({ fromSequence: 4813, reason: 'buffer overflowed' });
    await stream().onEvent(message(ROOM_A, 'hello'));

    expect(turns[0].gap).toContain('buffer overflowed');
    expect(turns[0].gap).toContain('4813');

    await agent.stop();
  });

  it('an eviction stops the agent acting anywhere', async () => {
    /**
     * Another stream took the connection over. Without this wire the host keeps
     * its rooms and keeps firing scheduled work into them, looking healthy while
     * receiving nothing — the failure the host's `evicted` exists for.
     */
    const { agent, turns, stream } = harness();
    await agent.ready;

    stream().onEvicted('taken over by another stream');
    await stream().onEvent(message(ROOM_A, 'too late'));

    expect(agent.host.rooms).toEqual([]);
    expect(turns).toHaveLength(0);

    await agent.stop();
  });
});

describe('stopping', () => {
  it('aborts the stream and drains the host', async () => {
    const { agent, stream } = harness();
    await agent.ready;
    expect(stream().signal.aborted).toBe(false);

    await agent.stop();

    expect(stream().signal.aborted).toBe(true);
  });

  it('is safe to call twice', async () => {
    const { agent } = harness();
    await agent.ready;

    await agent.stop();
    await expect(agent.stop()).resolves.toBeUndefined();
  });
});

describe('systemClock', () => {
  it('reads the wall clock', () => {
    const before = Date.now();
    expect(systemClock.now()).toBeGreaterThanOrEqual(before);
  });

  it('fires, and can be cancelled before it does', async () => {
    vi.useFakeTimers();
    try {
      let fired = 0;
      const cancel = systemClock.setTimer(50, () => {
        fired += 1;
      });
      systemClock.setTimer(50, () => {
        fired += 10;
      });

      cancel();
      vi.advanceTimersByTime(60);

      expect(fired).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps a delay a timer cannot hold, instead of firing at once', async () => {
    /**
     * Node keeps the delay in a 32-bit int, so above ~24.8 days `setTimeout`
     * fires *immediately*. `nextDelayMs` clamps, but it lives in another module
     * and a second caller would not inherit that — so the clamp is here too,
     * where the timer actually is.
     */
    vi.useFakeTimers();
    try {
      let fired = 0;
      systemClock.setTimer(MAX_TIMER_MS + 60_000, () => {
        fired += 1;
      });

      vi.advanceTimersByTime(1000);
      expect(fired).toBe(0);

      vi.advanceTimersByTime(MAX_TIMER_MS);
      expect(fired).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a negative delay as due now rather than never', () => {
    vi.useFakeTimers();
    try {
      let fired = 0;
      systemClock.setTimer(-5000, () => {
        fired += 1;
      });

      vi.advanceTimersByTime(1);

      expect(fired).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
