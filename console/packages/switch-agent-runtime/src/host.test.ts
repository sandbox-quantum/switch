import { describe, expect, it } from 'vitest';
import { MultiRoomHost, type Clock, type Turn } from './host';
import { MAX_TIMER_MS, serialiseWakeups, type Wakeup } from './schedule';

/**
 * The process that is a multi-room agent.
 *
 * Everything else on this branch is a mechanism: a scope the protocol accepts,
 * an operation that takes a room, a label, a schedule. Nothing opens a `multi`
 * connection and stays up, so no user story can actually be demonstrated. This
 * is that process — minus the part that drives a model, which is injected, so
 * what remains is the part with rules.
 *
 * Three of those rules are the whole reason this is not a `for` loop over an
 * event stream:
 *
 * - **Turns do not overlap.** There is one context window. Two events handled
 *   concurrently interleave two conversations inside it, and the agent answers
 *   each with half of the other. Everything queues behind the turn in flight.
 * - **A turn knows which room woke it**, because the reply has to go back to
 *   the surface the request came from and nothing else can tell it.
 * - **The room set is the server's to decide.** A room taken away mid-session
 *   stops being delivered and stops being a place scheduled work can land.
 */

const ROOM_A = '!a:switch.local';
const ROOM_B = '!b:switch.local';
const NOW = Date.UTC(2027, 0, 6, 9, 0, 0);

/** A clock the test advances by hand, so nothing waits on a real timer. */
function fakeClock(startMs = NOW) {
  let current = startMs;
  let pending: { at: number; fire: () => void; id: number } | null = null;
  let nextId = 1;

  return {
    clock: {
      now: () => current,
      setTimer(delayMs: number, fire: () => void) {
        const id = nextId++;
        pending = { at: current + delayMs, fire, id };
        return () => {
          if (pending?.id === id) pending = null;
        };
      },
    } satisfies Clock,
    /**
     * Move time forward and fire the timer if it is due.
     *
     * The caller drains the host afterwards rather than this counting
     * microtasks: a tick count is only ever right for the current shape of the
     * code, and adding one `await` inside the wake-up path silently turns a
     * negative test into one that passes because nothing has happened yet.
     */
    advance(byMs: number) {
      current += byMs;
      const due = pending;
      if (due && due.at <= current) {
        pending = null;
        due.fire();
      }
    },
    armed: () => pending !== null,
    delay: () => (pending ? pending.at - current : null),
  };
}

const SILENT = { debug() {}, warn() {}, error() {} };

/** Move the clock and let the host finish whatever that started. */
async function advanced(
  host: MultiRoomHost,
  time: { advance(ms: number): void },
  byMs: number
): Promise<void> {
  time.advance(byMs);
  await host.settled();
}

function message(roomId: string, body: string) {
  return {
    type: 'message',
    room_id: roomId,
    payload: { addressed: true, sender: '@u:s', sender_name: 'u', message_id: `$${body}`, body },
  } as never;
}

function harness(
  options: {
    rooms?: string[];
    stored?: Wakeup[];
    onTurn?: (turn: Turn) => Promise<void>;
  } = {}
) {
  const turns: Turn[] = [];
  const saved: string[] = [];
  const time = fakeClock();

  const host = new MultiRoomHost({
    rooms: options.rooms ?? [ROOM_A, ROOM_B],
    clock: time.clock,
    log: SILENT,
    loadSchedule: async () => serialiseWakeups(options.stored ?? []),
    saveSchedule: async (text) => {
      saved.push(text);
    },
    onTurn: async (turn) => {
      turns.push(turn);
      await options.onTurn?.(turn);
    },
  });

  return { host, turns, saved, time };
}

// ── One context window means one turn at a time ──────────────────────────────

describe('turns do not overlap', () => {
  it('holds a second event until the first turn finishes', async () => {
    /**
     * The property everything else depends on. Two turns in flight interleave
     * two conversations inside one context, and the agent answers each with
     * half of the other.
     */
    let release!: () => void;
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let concurrent = 0;
    let peak = 0;

    const { host, turns } = harness({
      onTurn: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        if (concurrent === 1) {
          started();
          await inFlight;
        }
        concurrent -= 1;
      },
    });
    await host.start();

    const first = host.deliver(message(ROOM_A, 'one'));
    const second = host.deliver(message(ROOM_B, 'two'));
    // A turn begins on a microtask, so wait for the first to actually be in
    // flight — asserting synchronously would only prove nothing had run yet.
    await firstStarted;
    expect(turns).toHaveLength(1);

    release();
    await Promise.all([first, second]);

    expect(peak).toBe(1);
    expect(turns).toHaveLength(2);
  });

  it('keeps queued events in the order they arrived', async () => {
    /**
     * The turns take differing time on purpose. With every turn synchronous the
     * pushes come out in call order whether or not anything is serialised, so
     * the test would pass with the chain removed — the first turn has to be the
     * slowest for unordered completion to reorder them.
     */
    const delays: Record<string, number> = { first: 3, second: 2, third: 1 };
    const { host, turns } = harness({
      onTurn: async (turn) => {
        const body = turn.kind === 'event' ? (turn.event.payload as { body: string }).body : '';
        for (let i = 0; i < (delays[body] ?? 0); i++) await Promise.resolve();
      },
    });
    await host.start();

    await Promise.all([
      host.deliver(message(ROOM_A, 'first')),
      host.deliver(message(ROOM_A, 'second')),
      host.deliver(message(ROOM_A, 'third')),
    ]);

    expect(turns.map((t) => (t.kind === 'event' ? t.event.payload.body : ''))).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('a turn that throws does not stop the next one', async () => {
    /** One bad turn must not silence the agent for the rest of the session. */
    let seen = 0;
    const { host, turns } = harness({
      onTurn: async () => {
        seen += 1;
        if (seen === 1) throw new Error('the model fell over');
      },
    });
    await host.start();

    await host.deliver(message(ROOM_A, 'one'));
    await host.deliver(message(ROOM_A, 'two'));

    expect(turns).toHaveLength(2);
  });
});

// ── A turn knows where it came from ──────────────────────────────────────────

describe('routing', () => {
  it('tells the turn which room woke it', async () => {
    const { host, turns } = harness();
    await host.start();

    await host.deliver(message(ROOM_B, 'over here'));

    expect(turns[0].roomId).toBe(ROOM_B);
  });

  it('drops an event for a room the server has taken away', async () => {
    /**
     * A `single`-scope session can claim a room out from under this connection.
     * The server stops delivering it, and anything already queued must not be
     * acted on either — the agent no longer holds that seat.
     */
    const { host, turns } = harness();
    await host.start();

    host.acceptRooms([ROOM_A]);
    await host.deliver(message(ROOM_B, 'not ours any more'));

    expect(turns).toHaveLength(0);
  });

  it('takes the server as the authority on what it holds', async () => {
    const { host } = harness();
    await host.start();

    host.acceptRooms([ROOM_A]);

    expect(host.rooms).toEqual([ROOM_A]);
  });
});

// ── Waking up on its own ─────────────────────────────────────────────────────

describe('scheduled wake-ups', () => {
  it('arms a timer for the soonest one on start', async () => {
    const { host, time } = harness({
      stored: [{ id: 'w1', atMs: NOW + 60_000, note: 'digest' }],
    });

    await host.start();

    expect(time.delay()).toBe(60_000);
  });

  it('runs a due wake-up as a turn', async () => {
    const { host, turns, time } = harness({
      stored: [{ id: 'w1', atMs: NOW + 1000, note: 'post the digest', roomId: ROOM_A }],
    });
    await host.start();

    await advanced(host, time, 1000);

    expect(turns).toHaveLength(1);
    expect(turns[0].kind).toBe('wakeup');
    expect(turns[0].roomId).toBe(ROOM_A);
  });

  it('a wake-up waits its turn like anything else', async () => {
    /** It is a turn in the same one context, not a second thread of thought. */
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let concurrent = 0;
    let peak = 0;

    const { host, turns, time } = harness({
      stored: [{ id: 'w1', atMs: NOW + 1000, note: 'digest' }],
      onTurn: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        if (concurrent === 1) {
          started();
          await blocked;
        }
        concurrent -= 1;
      },
    });
    await host.start();

    const event = host.deliver(message(ROOM_A, 'hello'));
    await firstStarted;
    // Fired while the event turn is still in flight, and not drained here —
    // draining would wait on the very turn this test is holding open.
    time.advance(1000);
    release();
    await event;
    await host.settled();

    expect(peak).toBe(1);
    // Both ran. Asserting only `peak` would pass just as well if the wake-up
    // had been dropped, the timer never armed, or the cycle thrown.
    expect(turns).toHaveLength(2);
    expect(turns[1].kind).toBe('wakeup');
  });

  it('does not fire a wake-up into a room it no longer holds', async () => {
    /**
     * The schedule outlives the room set. A weekly digest aimed at a room a
     * session took over would otherwise be posted where the agent has no seat,
     * or fail in a way nobody reads.
     */
    const { host, turns, time } = harness({
      stored: [{ id: 'w1', atMs: NOW + 1000, note: 'digest', roomId: ROOM_B }],
    });
    await host.start();

    host.acceptRooms([ROOM_A]);
    await advanced(host, time, 1000);

    expect(turns).toHaveLength(0);
  });

  it('retires a one-shot and re-arms for what is left', async () => {
    const { host, time } = harness({
      stored: [
        { id: 'once', atMs: NOW + 1000, note: 'a' },
        { id: 'later', atMs: NOW + 5000, note: 'b' },
      ],
    });
    await host.start();

    await advanced(host, time, 1000);

    expect(time.delay()).toBe(4000);
  });

  it('writes the schedule back after it changes', async () => {
    /** So a restart re-arms what is left rather than replaying what has run. */
    const { host, saved, time } = harness({
      stored: [{ id: 'once', atMs: NOW + 1000, note: 'a' }],
    });
    await host.start();

    await advanced(host, time, 1000);

    expect(saved).not.toHaveLength(0);
    expect(JSON.parse(saved[saved.length - 1])).toEqual([]);
  });

  it('arms nothing when the schedule is empty', async () => {
    const { host, time } = harness();

    await host.start();

    expect(time.armed()).toBe(false);
  });

  it('rehydrates rather than starting empty after a restart', async () => {
    /**
     * An actual restart: one host writes the schedule, a second reads what it
     * wrote and fires it. Asserting only that the first host armed a timer
     * tests the same path as the case above and calls it a restart.
     */
    const written: string[] = [];
    let stored = serialiseWakeups([]);
    const time = fakeClock();
    const turns: Turn[] = [];

    const make = () =>
      new MultiRoomHost({
        rooms: [ROOM_A],
        clock: time.clock,
        log: SILENT,
        loadSchedule: async () => stored,
        saveSchedule: async (text) => {
          written.push(text);
          stored = text;
        },
        onTurn: async (turn) => {
          turns.push(turn);
        },
      });

    const first = make();
    await first.start();
    await first.schedule({ id: 'w1', atMs: NOW + 1000, note: 'survives', roomId: ROOM_A });
    await first.stop();

    const second = make();
    await second.start();
    time.advance(1000);
    await second.settled();

    expect(turns).toHaveLength(1);
    expect(turns[0].kind).toBe('wakeup');
  });
});

// ── Degradation the agent has to be told about ───────────────────────────────

describe('gaps', () => {
  it('marks the next turn so the agent knows to re-read', async () => {
    /**
     * A gap is never surfaced as a turn of its own — the only response is to
     * re-read context, and the agent cannot know whether anything it cared
     * about was dropped, so waking it for one spends a turn on a maybe.
     */
    const { host, turns } = harness();
    await host.start();

    host.noteGap('buffer overflowed');
    await host.deliver(message(ROOM_A, 'hello'));

    expect(turns[0].gap).toContain('buffer overflowed');
  });

  it('reports a gap once, not on every turn after it', async () => {
    const { host, turns } = harness();
    await host.start();

    host.noteGap('buffer overflowed');
    await host.deliver(message(ROOM_A, 'one'));
    await host.deliver(message(ROOM_A, 'two'));

    expect(turns[0].gap).toBeDefined();
    expect(turns[1].gap).toBeUndefined();
  });
});

// ── Losing a room, or the connection ─────────────────────────────────────────

describe('what stops the agent acting', () => {
  it('drops a turn for a room taken away while it was queued', async () => {
    /**
     * The guard where the turn is accepted does not cover this: a turn waits
     * behind whatever is running, and the room can be claimed during that wait.
     * Replying into a room the agent has lost is not something it can be owed,
     * unlike finishing a turn accepted before a stop.
     */
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const firstStarted = new Promise<void>((r) => {
      started = r;
    });
    let seen = 0;

    const { host, turns } = harness({
      onTurn: async () => {
        seen += 1;
        if (seen === 1) {
          started();
          await blocked;
        }
      },
    });
    await host.start();

    const first = host.deliver(message(ROOM_A, 'thinking'));
    await firstStarted;
    const queued = host.deliver(message(ROOM_B, 'will be stale'));
    host.acceptRooms([ROOM_A]);
    release();
    await Promise.all([first, queued]);

    expect(turns).toHaveLength(1);
  });

  it('keeps the gap when the turn that would have carried it fails', async () => {
    /**
     * A gap says the agent is missing events. Losing it because the turn
     * carrying it threw leaves the agent answering from a stale picture with
     * nothing saying so — and a failing turn and a gap share their causes, so
     * they arrive together.
     */
    let seen = 0;
    const { host, turns } = harness({
      onTurn: async () => {
        seen += 1;
        if (seen === 1) throw new Error('the model fell over');
      },
    });
    await host.start();

    host.noteGap('buffer overflowed');
    await host.deliver(message(ROOM_A, 'one'));
    await host.deliver(message(ROOM_A, 'two'));

    expect(turns[1].gap).toContain('buffer overflowed');
  });

  it('stops waking and stops holding rooms when it is evicted', async () => {
    /**
     * Not a shutdown — nothing was finished and nothing asked for it. Another
     * stream took the connection over, so the agent no longer holds any room;
     * left as it was it would keep firing scheduled work into rooms it was
     * evicted from while the process looked healthy.
     */
    const { host, turns, time } = harness({
      stored: [{ id: 'w1', atMs: NOW + 1000, note: 'digest', roomId: ROOM_A }],
    });
    await host.start();

    host.evicted('another stream took this connection');

    expect(host.rooms).toEqual([]);
    expect(time.armed()).toBe(false);
    await advanced(host, time, 1000);
    expect(turns).toHaveLength(0);
  });

  it('a wake-up further out than a timer can hold re-arms across hops', async () => {
    /**
     * `nextDelayMs` clamps, so the first timer expires with nothing due. The
     * cycle has to notice that and arm again rather than treating an empty
     * `due` as the end of the schedule.
     */
    const { host, turns, time } = harness({
      stored: [{ id: 'far', atMs: NOW + MAX_TIMER_MS + 5000, note: 'monthly' }],
    });
    await host.start();

    expect(time.delay()).toBe(MAX_TIMER_MS);
    await advanced(host, time, MAX_TIMER_MS);
    expect(turns).toHaveLength(0);
    expect(time.delay()).toBe(5000);

    await advanced(host, time, 5000);
    expect(turns).toHaveLength(1);
  });
});

// ── Shutting down ────────────────────────────────────────────────────────────

describe('stop', () => {
  it('leaves no timer armed', async () => {
    const { host, time } = harness({
      stored: [{ id: 'w1', atMs: NOW + 60_000, note: 'digest' }],
    });
    await host.start();

    await host.stop();

    expect(time.armed()).toBe(false);
  });

  it('drains the turns a wake-up queued, not just the cycle that found them', async () => {
    /**
     * The wake-up cycle awaits a write before queueing the turns it found due,
     * so awaiting the chain once returns through that window — and those turns
     * then run against a transport the caller believed drained, posting into a
     * room after `stop` resolved or dying mid-sentence when the process exits.
     */
    let finished = false;
    const { host, time } = harness({
      stored: [{ id: 'w1', atMs: NOW + 1000, note: 'digest', roomId: ROOM_A }],
      onTurn: async () => {
        // Genuinely suspends, so "the turn ran to completion" is distinguishable
        // from "the turn was entered". Asserting only that it started passes
        // whether or not `stop` waited.
        await Promise.resolve();
        await Promise.resolve();
        finished = true;
      },
    });
    await host.start();

    time.advance(1000);
    await host.stop();

    expect(finished).toBe(true);
  });

  it('waits for the turn in flight rather than cutting it off', async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;

    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { host } = harness({
      onTurn: async () => {
        started();
        await inFlight;
        finished = true;
      },
    });
    await host.start();
    const turn = host.deliver(message(ROOM_A, 'mid-thought'));
    await hasStarted;

    const stopping = host.stop();
    release();
    await Promise.all([turn, stopping]);

    expect(finished).toBe(true);
  });

  it('refuses work after it has stopped', async () => {
    const { host, turns } = harness();
    await host.start();
    await host.stop();

    await host.deliver(message(ROOM_A, 'too late'));

    expect(turns).toHaveLength(0);
  });
});
