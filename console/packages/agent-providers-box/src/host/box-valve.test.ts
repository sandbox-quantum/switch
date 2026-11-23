import { describe, expect, it, vi } from 'vitest';
import {
  type AdmitAnswer,
  BoxValve,
  type BoxValveOptions,
  boxCap,
  type HostLink,
  type IdleSession,
  LET_GO_REASONS,
  type LetGoReason,
  REFUSE_REASONS,
  SHED_UNREADABLE_SETTLES,
  type ValveEvent,
} from './box-valve';
import { type ParkCandidate, PressureValve } from './memory-pressure';

const MIB = 1024 ** 2;
const GIB = 1024 * MIB;
const LIMIT = 6 * GIB;
const SESSION = 235 * MIB; // the 26 Oct flood's measured awake session
const SETTLE_MS = 150;
const FREE_MS = 100;
const quiet = { info: () => {}, warn: () => {} };

/**
 * Seen on a test box: with a login, every agent's host is its own
 * process, so each ran its own F1 valve over the same box memory. All of them
 * saw the box over its line at once and parked together: four parks in
 * 0.33 s, from 83% down to 66%.
 *
 * This replays that box: 5 hosts, 3 idle sessions apiece, the box at 83% of
 * 6 GiB, a session's memory going about 100 ms after it parks.
 */
function box(startPercent: number) {
  let usage = Math.round(LIMIT * startPercent);
  const parks: { at: number; sessionId: string; usageBefore: number }[] = [];
  const t0 = Date.now();
  const parked = new Set<string>();
  const idle = (index: number): IdleSession[] =>
    Array.from({ length: 3 }, (_, j) => ({
      sessionId: `host-${index}-session-${j}`,
      idleSinceMs: t0 - (index * 3 + j + 1) * 60_000,
      duplicate: true,
    })).filter((s) => !parked.has(s.sessionId));
  const park = async (sessionId: string) => {
    parked.add(sessionId);
    parks.push({ at: Date.now() - t0, sessionId, usageBefore: usage });
    setTimeout(() => {
      usage -= SESSION;
    }, FREE_MS);
    return true;
  };
  return { readUsage: async () => usage, idle, park, parks, usage: () => usage };
}

function expectOneParkPerSettle(b: ReturnType<typeof box>) {
  const inFirstSettle = b.parks.filter((p) => p.at < SETTLE_MS).length;
  expect(inFirstSettle).toBe(1);
  // Parks are spaced at least a settle apart.
  for (let i = 1; i < b.parks.length; i++)
    expect(b.parks[i]!.at - b.parks[i - 1]!.at).toBeGreaterThanOrEqual(SETTLE_MS - 20);
  // It stops once under the 65% line: no park is made with the box already under it.
  for (const p of b.parks) expect(p.usageBefore).toBeGreaterThanOrEqual(0.65 * LIMIT);
  // So it never overshoots by more than one session below the line.
  expect(b.usage()).toBeGreaterThan(0.65 * LIMIT - SESSION);
}

describe('the box-wide valve', () => {
  it('parks one session per settle across 5 isolated hosts, and stops once the box is under its line', async () => {
    const b = box(0.83);
    const valve = new BoxValve({
      limit: LIMIT,
      readUsage: b.readUsage,
      settleMs: SETTLE_MS,
      cap: 100,
      log: quiet,
    });
    for (let i = 0; i < 5; i++)
      valve.connect(link(`agent-${i}`, { idle: () => b.idle(i), park: b.park }));
    // Each host's watch timer used to fire within the same few milliseconds.
    await Promise.all(Array.from({ length: 5 }, () => valve.check()));
    await new Promise((resolve) => setTimeout(resolve, FREE_MS + 20));
    expectOneParkPerSettle(b);
    expect(b.parks.length).toBe(5);
  });

  it('today: one valve per host process over-parks the same box (the bug the box valve fixes)', async () => {
    const b = box(0.83);
    const valves = Array.from({ length: 5 }, (_, i) => {
      const valve = new PressureValve({
        limit: LIMIT,
        readUsage: b.readUsage,
        settleMs: SETTLE_MS,
      });
      valve.register(() =>
        b.idle(i).map((c): ParkCandidate => ({ ...c, park: () => b.park(c.sessionId) }))
      );
      return valve;
    });
    await Promise.all(valves.map((valve) => valve.check()));
    expect(b.parks.filter((p) => p.at < SETTLE_MS).length).toBe(5);
  });
});

type FakeLink = HostLink & {
  awakeCount: number;
  idleList: IdleSession[];
  starts: { sessionId: string; lease: string }[];
  letGos: { messageId: string; reason: LetGoReason }[];
  parked: string[];
};

function link(
  agentId: string,
  over: Partial<Pick<HostLink, 'idle' | 'park' | 'awake'>> = {}
): FakeLink {
  // awake may be reassigned by a test.
  const fake: FakeLink = {
    agentId,
    awakeCount: 0,
    idleList: [],
    starts: [],
    letGos: [],
    parked: [],
    awake: over.awake ?? (() => fake.awakeCount),
    idle: over.idle ?? (() => fake.idleList),
    park:
      over.park ??
      (async (sessionId) => {
        fake.parked.push(sessionId);
        fake.idleList = fake.idleList.filter((s) => s.sessionId !== sessionId);
        fake.awakeCount--;
        return true;
      }),
    start: (sessionId, lease) => fake.starts.push({ sessionId, lease }),
    letGo: (messageId, reason) => fake.letGos.push({ messageId, reason }),
  };
  return fake;
}

function valveWith(over: Partial<BoxValveOptions> = {}) {
  let usage = 0.5 * LIMIT;
  let clock = 1_000_000;
  const valve = new BoxValve({
    limit: LIMIT,
    readUsage: async () => usage,
    settleMs: 0,
    cap: 3,
    now: () => clock,
    log: quiet,
    ...over,
  });
  return {
    valve,
    setUsage: (fraction: number) => {
      usage = fraction * LIMIT;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

const ok = (answer: AdmitAnswer) => {
  if (!answer.ok) throw new Error(`refused: ${answer.reason}`);
  return answer.lease;
};

describe('the cap from box memory', () => {
  it.each([
    [2, 3],
    [4, 8],
    [6, 12],
    [8, 16],
  ])('%i GiB gives %i', (gib, cap) => {
    expect(boxCap(gib * GIB, {}).cap).toBe(cap);
  });

  it('is at least 1', () => {
    expect(boxCap(256 * MIB, {}).cap).toBe(1);
  });

  it('the env bound only lowers it: above the formula it is ignored, below it wins', () => {
    expect(boxCap(6 * GIB, { SWITCH_BOX_MAX_AWAKE_SESSIONS: '15' })).toEqual({
      cap: 12,
      formula: 12,
      bound: 15,
    });
    expect(boxCap(6 * GIB, { SWITCH_BOX_MAX_AWAKE_SESSIONS: '5' }).cap).toBe(5);
  });

  it('a bad env value is ignored with a warning, never read as no limit', () => {
    const warn = vi.fn();
    expect(boxCap(6 * GIB, { SWITCH_BOX_MAX_AWAKE_SESSIONS: '0' }, { warn }).cap).toBe(12);
    expect(boxCap(6 * GIB, { SWITCH_BOX_MAX_AWAKE_SESSIONS: 'lots' }, { warn }).cap).toBe(12);
    expect(warn).toHaveBeenCalledTimes(2);
    // Numbers and no names, and never the raw value.
    expect(String(warn.mock.calls[1]![0])).not.toContain('lots');
  });
});

describe('BoxValve: admitting starts', () => {
  it('a host whose count fails keeps its last known count, never none', async () => {
    const { valve } = valveWith({ cap: 2 });
    const a = link('a');
    a.awakeCount = 2;
    let failing = false;
    a.awake = () => {
      if (failing) throw new Error('gone wrong');
      return a.awakeCount;
    };
    const ca = valve.connect(a);
    expect(valve.awake).toBe(2);
    failing = true;
    expect(valve.awake).toBe(2);
    expect(await ca.admit('a-3', 'message')).toEqual({ ok: false, reason: 'cap' });
  });

  it('a host that has not said yet counts its health file’s figure, and the larger of the two wins', async () => {
    const { valve } = valveWith({ cap: 2 });
    const a = link('a', { awake: () => null });
    const ca = valve.connect(a);
    expect(valve.awake).toBe(0);
    valve.noteHealth('a', 2);
    expect(valve.awake).toBe(2);
    expect(await ca.admit('a-3', 'message')).toEqual({ ok: false, reason: 'cap' });
    // Its own report, lower than health, doesn't lower the count: high, never low.
    const b = link('b');
    b.awakeCount = 0;
    valve.connect(b);
    valve.noteHealth('b', 1);
    expect(valve.awake).toBe(3);
  });

  it('counts awake sessions and starts in flight across hosts against one cap', async () => {
    const { valve } = valveWith({ cap: 3 });
    const a = link('a');
    const b = link('b');
    a.awakeCount = 1;
    b.awakeCount = 1;
    const ca = valve.connect(a);
    const cb = valve.connect(b);
    ok(await ca.admit('a-2', 'message'));
    // 1 + 1 awake and 1 starting: a fourth is over the cap, and nobody is idle to park.
    expect(await cb.admit('b-2', 'message')).toEqual({ ok: false, reason: 'cap' });
  });

  it('parks the quietest idle session box-wide to make room under the cap', async () => {
    const { valve } = valveWith({ cap: 2 });
    const a = link('a');
    const b = link('b');
    a.awakeCount = 1;
    a.idleList = [{ sessionId: 'a-1', idleSinceMs: 500, duplicate: false }];
    b.awakeCount = 1;
    b.idleList = [{ sessionId: 'b-1', idleSinceMs: 100, duplicate: false }];
    valve.connect(a);
    const cb = valve.connect(b);
    ok(await cb.admit('b-2', 'message'));
    // The longest idle across the box, which is b's own.
    expect(b.parked).toEqual(['b-1']);
    expect(a.parked).toEqual([]);
  });

  it('idle at cap: parks one and admits the new start in the same decision, with no wait for the counts', async () => {
    const { valve } = valveWith({ cap: 2 });
    const a = link('a');
    a.awakeCount = 2;
    a.idleList = [{ sessionId: 'a-1', idleSinceMs: 1, duplicate: false }];
    // The host agrees to park, but its count (and its health file) still say 2 for a while.
    a.park = async (sessionId) => {
      a.parked.push(sessionId);
      a.idleList = [];
      return true;
    };
    valve.noteHealth('a', 2);
    const ca = valve.connect(a);
    const started = Date.now();
    const answer = await ca.admit('a-3', 'message');
    expect(answer.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(a.parked).toEqual(['a-1']);
    // The box reads one over until the reports catch up: no further start gets in meanwhile.
    expect(await valve.connect(link('b')).admit('b-1', 'message')).toEqual({
      ok: false,
      reason: 'cap',
    });
  });

  it('a park the count already shows is not counted twice: the box never goes over its cap', async () => {
    const { valve } = valveWith({ cap: 3 });
    const a = link('a');
    a.awakeCount = 3;
    a.idleList = Array.from({ length: 3 }, (_, i) => ({
      sessionId: `a-${i}`,
      idleSinceMs: i,
      duplicate: false,
    }));
    // This host's count drops at once when it parks (the default fake).
    const ca = valve.connect(a);
    for (let i = 0; i < 3; i++) {
      expect((await ca.admit(`new-${i}`, 'message')).ok).toBe(true);
      expect(valve.awake + valve.starting).toBeLessThanOrEqual(3);
    }
    expect(a.parked).toHaveLength(3);
  });

  it('two starts at cap: one park and one admit, then the second waits with no extra park', async () => {
    const { valve } = valveWith({ cap: 2 });
    const a = link('a');
    a.awakeCount = 2;
    a.idleList = [
      { sessionId: 'a-1', idleSinceMs: 1, duplicate: false },
      { sessionId: 'a-2', idleSinceMs: 2, duplicate: false },
    ];
    // The host agrees to park, but its counts stay stale for a while.
    a.park = async (sessionId) => {
      a.parked.push(sessionId);
      a.idleList = a.idleList.filter((s) => s.sessionId !== sessionId);
      return true;
    };
    valve.noteHealth('a', 2);
    const ca = valve.connect(a);
    expect((await ca.admit('new-1', 'message')).ok).toBe(true);
    expect(await ca.admit('new-2', 'message')).toEqual({ ok: false, reason: 'cap' });
    // Only the one park: the second start didn't rest another conversation for nothing.
    expect(a.parked).toEqual(['a-1']);
  });

  it('once the parked session has left the health read, a later start may park again', async () => {
    const { valve, advance } = valveWith({ cap: 2 });
    const a = link('a');
    a.awakeCount = 2;
    a.idleList = [
      { sessionId: 'a-1', idleSinceMs: 1, duplicate: false },
      { sessionId: 'a-2', idleSinceMs: 2, duplicate: false },
    ];
    a.park = async (sessionId) => {
      a.parked.push(sessionId);
      a.idleList = a.idleList.filter((s) => s.sessionId !== sessionId);
      return true;
    };
    valve.noteHealth('a', 2);
    const ca = valve.connect(a);
    const lease = await ca.admit('new-1', 'message');
    expect(lease.ok).toBe(true);
    if (lease.ok) ca.settle(lease.lease, true);
    // The status poll reads the box again, past the settle time (on the valve's own clock): a-1 gone, new-1 up,
    // still at the cap.
    advance(2_000);
    valve.noteHealth('a', 2);
    expect((await ca.admit('new-2', 'message')).ok).toBe(true);
    expect(a.parked).toEqual(['a-1', 'a-2']);
  });

  it('a count that rises while the park is awaited frees at most the one slot', async () => {
    const { valve } = valveWith({ cap: 3 });
    const a = link('a');
    const b = link('b');
    a.awakeCount = 2;
    b.awakeCount = 1;
    a.idleList = [{ sessionId: 'a-1', idleSinceMs: 1, duplicate: false }];
    valve.noteHealth('a', 2);
    // While the park is awaited, a stale report raises b's count by one, and the parked session stays counted.
    a.park = async (sessionId) => {
      a.parked.push(sessionId);
      a.idleList = [];
      valve.noteHealth('b', 2);
      return true;
    };
    valve.connect(b);
    const ca = valve.connect(a);
    // Before the fix this freed two slots and let the start in over the cap.
    expect(await ca.admit('a-new', 'message')).toEqual({ ok: false, reason: 'cap' });
  });

  it('a start in flight that turns awake during the park still leaves room for exactly one', async () => {
    const { valve } = valveWith({ cap: 3 });
    const a = link('a');
    a.awakeCount = 2;
    a.idleList = [{ sessionId: 'a-1', idleSinceMs: 1, duplicate: false }];
    const ca = valve.connect(a);
    const first = await ca.admit('a-new-1', 'message');
    expect(first.ok).toBe(true);
    // During the next park the first start comes up: starting -1, awake +1. The parked one stays counted.
    a.park = async (sessionId) => {
      a.parked.push(sessionId);
      a.idleList = [];
      a.awakeCount = 3;
      if (first.ok) ca.settle(first.lease, true);
      return true;
    };
    expect((await ca.admit('a-new-2', 'message')).ok).toBe(true);
    // One over at most (the parked session, still counted), never two.
    expect(valve.awake + valve.starting).toBeLessThanOrEqual(3 + 1);
    expect(await ca.admit('a-new-3', 'message')).toEqual({ ok: false, reason: 'cap' });
  });

  it('a park the host refuses frees nothing: the start is refused for the cap', async () => {
    const { valve } = valveWith({ cap: 1 });
    const a = link('a', { park: async () => false });
    a.awakeCount = 1;
    a.idleList = [{ sessionId: 'a-1', idleSinceMs: 1, duplicate: false }];
    const ca = valve.connect(a);
    expect(await ca.admit('a-2', 'message')).toEqual({ ok: false, reason: 'cap' });
  });

  it('refuses for memory past the refuse line, counting starts in flight', async () => {
    const { valve, setUsage } = valveWith({ cap: 100, startReserve: 512 * MIB });
    const ca = valve.connect(link('a'));
    setUsage(0.8);
    ok(await ca.admit('s1', 'message'));
    // 80% + two reserves of 512 MiB is past 90% of 6 GiB.
    expect(await ca.admit('s2', 'message')).toEqual({ ok: false, reason: 'memory' });
  });

  it('a warm never parks anyone, and is refused at info, not warn', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const { valve } = valveWith({ cap: 1, log });
    const a = link('a');
    a.awakeCount = 1;
    a.idleList = [{ sessionId: 'a-1', idleSinceMs: 1, duplicate: false }];
    const ca = valve.connect(a);
    expect(await ca.admit('a-2', 'warm')).toEqual({ ok: false, reason: 'cap' });
    expect(a.parked).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('leases are dropped the moment the host disconnects', async () => {
    const { valve } = valveWith({ cap: 1 });
    const ca = valve.connect(link('a'));
    ok(await ca.admit('a-1', 'message'));
    expect(valve.starting).toBe(1);
    ca.close();
    expect(valve.starting).toBe(0);
    ok(await valve.connect(link('b')).admit('b-1', 'message'));
  });

  it('leases not settled expire', async () => {
    const { valve, advance } = valveWith({ cap: 1, leaseMs: 35_000 });
    const ca = valve.connect(link('a'));
    ok(await ca.admit('a-1', 'message'));
    advance(34_999);
    expect(valve.starting).toBe(1);
    advance(1);
    expect(valve.starting).toBe(0);
  });

  it('settle frees the slot; a lease settled by another host is ignored', async () => {
    const { valve } = valveWith({ cap: 1 });
    const ca = valve.connect(link('a'));
    const cb = valve.connect(link('b'));
    const lease = ok(await ca.admit('a-1', 'message'));
    cb.settle(lease);
    expect(valve.starting).toBe(1);
    ca.settle(lease);
    expect(valve.starting).toBe(0);
  });

  it('a held agent is refused with held, its sessions are never parked, and they still count until gone', async () => {
    const held = new Set(['a']);
    const { valve } = valveWith({ cap: 2, isHeld: (id) => held.has(id) });
    const a = link('a');
    a.awakeCount = 1;
    a.idleList = [{ sessionId: 'a-1', idleSinceMs: 1, duplicate: false }];
    const ca = valve.connect(a);
    const cb = valve.connect(link('b'));
    expect(await ca.admit('a-2', 'message')).toEqual({ ok: false, reason: 'held' });
    // a's session is still running while the guard stops it: it counts.
    expect(valve.awake).toBe(1);
    ok(await cb.admit('b-1', 'message'));
    expect(await cb.admit('b-2', 'message')).toEqual({ ok: false, reason: 'cap' });
    // And it is never parked to make room: the guard is dealing with it.
    expect(a.parked).toEqual([]);
    // Gone: it no longer counts.
    a.awakeCount = 0;
    expect(valve.awake).toBe(0);
  });

  it('with the box past the backstop and no fresh launcher figures, still refuses starts and parks on its own reading', async () => {
    // The launcher is quiet (no fresh figures), so starts are paused; the
    // valve's own box reading is all it needs to act.
    const { valve, setUsage } = valveWith({ cap: 10, admitting: () => false });
    const a = link('a');
    const b = link('b');
    a.idleList = [{ sessionId: 'a-1', idleSinceMs: 5, duplicate: false }];
    b.idleList = [{ sessionId: 'b-1', idleSinceMs: 1, duplicate: false }];
    a.awakeCount = 1;
    b.awakeCount = 1;
    const ca = valve.connect(a);
    valve.connect(b);
    setUsage(0.95);
    expect(await ca.admit('a-2', 'message')).toEqual({ ok: false, reason: 'limit' });
    await valve.check();
    expect([...a.parked, ...b.parked].sort()).toEqual(['a-1', 'b-1']);
  });

  it('admits nothing while starts are paused (the launcher quiet), and parks every idle session on asking', async () => {
    let admitting = false;
    const held = new Set(['c']);
    const { valve } = valveWith({
      cap: 10,
      admitting: () => admitting,
      isHeld: (id) => held.has(id),
    });
    const a = link('a');
    const b = link('b');
    const c = link('c');
    a.idleList = [{ sessionId: 'a-1', idleSinceMs: 5, duplicate: false }];
    b.idleList = [
      { sessionId: 'b-1', idleSinceMs: 1, duplicate: false },
      { sessionId: 'b-2', idleSinceMs: 9, duplicate: false },
    ];
    c.idleList = [{ sessionId: 'c-1', idleSinceMs: 1, duplicate: false }];
    const ca = valve.connect(a);
    valve.connect(b);
    valve.connect(c);
    expect(await ca.admit('a-2', 'message')).toEqual({ ok: false, reason: 'limit' });
    expect(await valve.parkIdle()).toBe(3);
    expect([...a.parked, ...b.parked].sort()).toEqual(['a-1', 'b-1', 'b-2']);
    // A held agent is the guard's: never parked here.
    expect(c.parked).toEqual([]);
    admitting = true;
    ok(await ca.admit('a-2', 'message'));
  });

  it('counts each park a host confirmed since start, for the report, and none it refused', async () => {
    const { valve } = valveWith({ cap: 10, admitting: () => false });
    const a = link('a');
    const refusing = link('b', { park: async () => false });
    a.idleList = [
      { sessionId: 'a-1', idleSinceMs: 5, duplicate: false },
      { sessionId: 'a-2', idleSinceMs: 6, duplicate: false },
    ];
    refusing.idleList = [{ sessionId: 'b-1', idleSinceMs: 1, duplicate: false }];
    valve.connect(a);
    valve.connect(refusing);
    expect(valve.parks).toBe(0);
    expect(await valve.parkIdle()).toBe(2);
    expect(valve.parks).toBe(2);
    a.idleList = [{ sessionId: 'a-3', idleSinceMs: 7, duplicate: false }];
    await valve.parkIdle();
    expect(valve.parks).toBe(3);
  });

  it('a removed agent stops counting: its health figure is dropped when the poll no longer lists it', () => {
    const { valve } = valveWith({ cap: 5 });
    valve.noteHealth('a', 2);
    valve.noteHealth('b', 1);
    expect(valve.awake).toBe(3);
    valve.keepHealthOnly(['b']);
    expect(valve.awake).toBe(1);
    // Its health read time goes too, not only its count.
    const readAt = (valve as unknown as { healthReadAt: Map<string, number> }).healthReadAt;
    expect([...readAt.keys()]).toEqual(['b']);
  });

  it('a closed connection stops counting at once, with no health figure behind it', () => {
    const { valve } = valveWith({ cap: 5 });
    const a = link('a');
    a.awakeCount = 2;
    const ca = valve.connect(a);
    expect(valve.awake).toBe(2);
    ca.close();
    expect(valve.awake).toBe(0);
  });

  it('a host that disconnected still counts what its health file shows until the next read', () => {
    const { valve } = valveWith({ cap: 5 });
    const a = link('a');
    a.awakeCount = 2;
    valve.connect(a).close();
    valve.noteHealth('a', 2);
    expect(valve.awake).toBe(2);
    valve.noteHealth('a', 0);
    expect(valve.awake).toBe(0);
  });

  it('off without a box limit: everything is admitted', async () => {
    const valve = new BoxValve({ limit: null, readUsage: async () => null, log: quiet });
    const ca = valve.connect(link('a'));
    for (let i = 0; i < 50; i++) ok(await ca.admit(`s${i}`, 'message'));
    expect(valve.status().cap).toBeNull();
  });

  it('every refusal reason is one of the fixed codes', () => {
    expect(REFUSE_REASONS).toEqual(['busy', 'cap', 'memory', 'limit', 'held']);
    expect(LET_GO_REASONS).toEqual(['timed_out', 'list_full', 'agent_full', 'reset', 'held']);
  });
});

const wait = (
  messageId: string,
  sessionId: string,
  sinceMs: number,
  kind: 'room' | 'start' = 'room'
) => ({
  roomId: `room-${messageId}`,
  messageId,
  sessionId,
  sinceMs,
  kind,
});

describe('BoxValve: the box-wide wait list', () => {
  it('gives room oldest first across agents, and a new start goes behind the waiters', async () => {
    const { valve, now, advance } = valveWith({ cap: 1 });
    const a = link('a');
    const b = link('b');
    a.awakeCount = 1;
    const ca = valve.connect(a);
    const cb = valve.connect(b);
    expect(ca.wait(wait('m1', 'a-2', now()))).toBe('waiting');
    advance(1000);
    expect(cb.wait(wait('m2', 'b-1', now()))).toBe('waiting');
    // b asks straight out: others are waiting, so it goes behind them.
    expect(await cb.admit('b-1', 'message')).toEqual({ ok: false, reason: 'busy' });
    // Room frees: a's session goes first, it is told to start and its admit takes the lease.
    a.awakeCount = 0;
    await valve.tick();
    expect(a.starts.map((s) => s.sessionId)).toEqual(['a-2']);
    expect(b.starts).toEqual([]);
    const lease = ok(await ca.admit('a-2', 'message'));
    expect(lease).toBe(a.starts[0]!.lease);
    ca.unwait('m1');
    a.awakeCount = 1;
    ca.settle(lease);
    // Still full: b waits on.
    await valve.tick();
    expect(b.starts).toEqual([]);
  });

  it('holds 20 per box and 10 per agent', () => {
    const { valve, now } = valveWith();
    const conns = ['a', 'b', 'c'].map((id) => valve.connect(link(id)));
    for (let i = 0; i < 10; i++)
      expect(conns[0]!.wait(wait(`a${i}`, `a-${i}`, now()))).toBe('waiting');
    expect(conns[0]!.wait(wait('a10', 'a-10', now()))).toBe('agent_full');
    for (let i = 0; i < 10; i++)
      expect(conns[1]!.wait(wait(`b${i}`, `b-${i}`, now()))).toBe('waiting');
    expect(conns[2]!.wait(wait('c0', 'c-0', now()))).toBe('list_full');
    // Start waits count towards both.
    conns[0]!.unwait('a0');
    expect(conns[2]!.wait(wait('c1', 'c-1', now(), 'start'))).toBe('waiting');
    expect(conns[0]!.wait(wait('a11', 'a-11', now()))).toBe('list_full');
  });

  it('lets go at 10 minutes with timed_out', async () => {
    const { valve, now, advance } = valveWith({ cap: 1 });
    const a = link('a');
    a.awakeCount = 5;
    const ca = valve.connect(a);
    ca.wait(wait('m1', 'a-9', now()));
    advance(10 * 60_000 - 1);
    await valve.tick();
    expect(a.letGos).toEqual([]);
    advance(1);
    await valve.tick();
    expect(a.letGos).toEqual([{ messageId: 'm1', reason: 'timed_out' }]);
    expect(valve.status().waiting).toBe(0);
  });

  it('a live wait is placed when it arrives: a host cannot jump the queue with an old time', async () => {
    const { valve, now, advance } = valveWith({ cap: 1 });
    const a = link('a');
    const b = link('b');
    a.awakeCount = 1;
    const ca = valve.connect(a);
    const cb = valve.connect(b);
    ca.wait(wait('m1', 'a-2', now()));
    advance(1000);
    // b claims it has waited an hour.
    cb.wait(wait('m2', 'b-1', now() - 3_600_000));
    a.awakeCount = 0;
    await valve.tick();
    expect(a.starts.length).toBe(1);
    expect(b.starts.length).toBe(0);
  });

  it('a hello just after a restart keeps a waiter’s journal time, back to the restart less 10 minutes', async () => {
    const { valve, now } = valveWith({ cap: 1 });
    const a = link('a');
    const b = link('b');
    a.awakeCount = 1;
    const ca = valve.connect(a);
    const cb = valve.connect(b);
    expect(ca.hello([wait('m1', 'a-2', now() - 60_000)])).toEqual(['waiting']);
    expect(cb.hello([wait('m2', 'b-1', now() - 9 * 60_000)])).toEqual(['waiting']);
    // Older than restart − 10 minutes: past its limit already.
    expect(cb.hello([wait('m3', 'b-3', now() - 11 * 60_000)])).toEqual(['timed_out']);
    a.awakeCount = 0;
    await valve.tick();
    expect(b.starts.map((s) => s.sessionId)).toEqual(['b-1']);
    expect(a.starts.length).toBe(0);
  });

  it('a hello long after the restart can’t bring an unseen waiter in with an old time', async () => {
    const { valve, now, advance } = valveWith({ cap: 1 });
    const a = link('a');
    const b = link('b');
    a.awakeCount = 1;
    advance(5 * 60_000);
    const ca = valve.connect(a);
    const cb = valve.connect(b);
    ca.wait(wait('m1', 'a-2', now()));
    advance(1000);
    expect(cb.hello([wait('m2', 'b-1', now() - 5 * 60_000)])).toEqual(['waiting']);
    a.awakeCount = 0;
    await valve.tick();
    expect(a.starts.length).toBe(1);
    expect(b.starts.length).toBe(0);
  });

  it('a host that drops and comes back keeps its waiters’ place', async () => {
    const { valve, now, advance } = valveWith({ cap: 1 });
    const a = link('a');
    const b = link('b');
    b.awakeCount = 1;
    advance(5 * 60_000);
    const ca = valve.connect(a);
    const cb = valve.connect(b);
    ca.wait(wait('m1', 'a-1', now()));
    advance(1000);
    cb.wait(wait('m2', 'b-2', now()));
    ca.close();
    advance(2000);
    const a2 = link('a');
    const ca2 = valve.connect(a2);
    expect(ca2.hello([wait('m1', 'a-1', now() - 3000)])).toEqual(['waiting']);
    b.awakeCount = 0;
    await valve.tick();
    expect(a2.starts.map((s) => s.sessionId)).toEqual(['a-1']);
    expect(b.starts.length).toBe(0);
  });

  it('a reconnect re-sends its waiters without losing their place', () => {
    const { valve, now } = valveWith();
    const first = valve.connect(link('a'));
    expect(first.wait(wait('m1', 's', now()))).toBe('waiting');
    // The old connection is still open when the new one says hello (a quick reconnect).
    const second = valve.connect(link('a'));
    expect(second.hello([wait('m1', 's', now())])).toEqual(['already']);
    first.close();
    // Moved to the new connection, so the old one closing didn't drop it.
    expect(valve.status().waiting).toBe(1);
  });

  it('a host disconnecting drops its waiters without a line', () => {
    const { valve, now } = valveWith();
    const a = link('a');
    const ca = valve.connect(a);
    ca.wait(wait('m1', 's', now()));
    ca.close();
    expect(valve.status().waiting).toBe(0);
    expect(a.letGos).toEqual([]);
  });

  it('ids are read as the connection’s own agent: one agent cannot unwait another’s message', () => {
    const { valve, now } = valveWith();
    const ca = valve.connect(link('a'));
    const cb = valve.connect(link('b'));
    ca.wait(wait('m1', 's', now()));
    cb.unwait('m1');
    expect(valve.status().waiting).toBe(1);
  });

  it('the guard dropping an agent takes its leases and waiters at once', async () => {
    const { valve, now } = valveWith({ cap: 5 });
    const ca = valve.connect(link('a'));
    ok(await ca.admit('s1', 'message'));
    ca.wait(wait('m1', 's2', now()));
    valve.dropAgent('a');
    expect(valve.starting).toBe(0);
    expect(valve.status().waiting).toBe(0);
  });

  it('a held agent’s waiters are refused with held and never given room', async () => {
    const held = new Set<string>();
    const { valve, now } = valveWith({ cap: 5, isHeld: (id) => held.has(id) });
    const a = link('a');
    const ca = valve.connect(a);
    expect(ca.wait(wait('m1', 's1', now()))).toBe('waiting');
    held.add('a');
    expect(ca.wait(wait('m2', 's2', now()))).toBe('held');
    await valve.tick();
    expect(a.starts).toEqual([]);
  });

  it('a session given room that fails to start is stepped over, so it never holds the rest up', async () => {
    const { valve, now, advance } = valveWith({ cap: 1 });
    const a = link('a');
    const b = link('b');
    const ca = valve.connect(a);
    const cb = valve.connect(b);
    ca.wait(wait('m1', 'a-1', now()));
    advance(10);
    cb.wait(wait('m2', 'b-1', now()));
    await valve.tick();
    expect(a.starts.length).toBe(1);
    // a's start fails for another reason: it settles without its message leaving.
    const lease = ok(await ca.admit('a-1', 'message'));
    ca.settle(lease, false);
    await valve.tick();
    expect(b.starts.map((s) => s.sessionId)).toEqual(['b-1']);
  });

  it('a start that succeeds is not stepped over, even settled before its messages leave', async () => {
    const { valve, now } = valveWith({ cap: 2, stepOverMs: 60_000 });
    const a = link('a');
    const ca = valve.connect(a);
    ca.wait(wait('m1', 'a-1', now()));
    await valve.tick();
    const lease = ok(await ca.admit('a-1', 'message'));
    // Up: the host settles first, then takes its messages off.
    ca.settle(lease, true);
    const stepped = (valve as unknown as { steppedOver: Map<string, number> }).steppedOver;
    expect(stepped.size).toBe(0);
    ca.unwait('m1');
  });

  it('forgets step-overs past their time, so the map never grows without end', async () => {
    const { valve, now, advance } = valveWith({ cap: 1, stepOverMs: 1000 });
    const a = link('a');
    a.awakeCount = 1;
    const ca = valve.connect(a);
    const stepped = (valve as unknown as { steppedOver: Map<string, number> }).steppedOver;
    for (let i = 0; i < 5; i++) {
      ca.wait(wait(`m${i}`, `s${i}`, now()));
      a.awakeCount = 0;
      await valve.tick();
      const lease = ok(await ca.admit(`s${i}`, 'message'));
      ca.settle(lease, false);
      a.awakeCount = 1;
    }
    expect(stepped.size).toBe(5);
    advance(1000);
    await valve.tick();
    expect(stepped.size).toBe(0);
  });

  it('a host that closes while its admit is making room gets no lease', async () => {
    const { valve } = valveWith({ cap: 1 });
    const other = link('other', {
      park: async (sessionId) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        other.idleList = other.idleList.filter((s) => s.sessionId !== sessionId);
        other.awakeCount = 0;
        return true;
      },
    });
    other.awakeCount = 1;
    other.idleList = [{ sessionId: 'o-1', idleSinceMs: 1, duplicate: false }];
    valve.connect(other);
    const ca = valve.connect(link('a'));
    const admitting = ca.admit('a-1', 'message');
    await new Promise((resolve) => setTimeout(resolve, 10));
    ca.close();
    expect(await admitting).toEqual({ ok: false, reason: 'limit' });
    expect(valve.starting).toBe(0);
  });

  it('logs refusals at most once a minute per reason, with a count', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const { valve } = valveWith({ cap: 1, log });
    const a = link('a');
    a.awakeCount = 1;
    const ca = valve.connect(a);
    for (let i = 0; i < 10; i++)
      expect(await ca.admit(`s${i}`, 'message')).toEqual({ ok: false, reason: 'cap' });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('back from the hub over the cap (17 awake, cap 15): parks idle sessions one at a time, then the waiter starts', async () => {
    const SETTLE = 40;
    const { valve, now } = valveWith({ cap: 15, settleMs: SETTLE });
    const parks: number[] = [];
    const hosts = Array.from({ length: 3 }, (_, i) => {
      const host = link(`agent-${i}`);
      host.awakeCount = i === 0 ? 7 : 5;
      // Two busy sessions per host are never offered; the rest are idle.
      host.idleList = Array.from({ length: host.awakeCount - 2 }, (_, j) => ({
        sessionId: `h${i}-s${j}`,
        idleSinceMs: j + i * 10,
        duplicate: false,
      }));
      const park = host.park;
      host.park = async (sessionId) => {
        parks.push(Date.now());
        return park(sessionId);
      };
      valve.connect(host);
      return host;
    });
    const waiting = link('waiting');
    const cw = valve.connect(waiting);
    cw.wait(wait('m1', 'w-1', now()));
    // Each round parks at most one, a settle after the last, until it fits.
    for (let round = 0; round < 6 && !waiting.starts.length; round++) await valve.tick();
    expect(parks.length).toBe(3);
    for (let i = 1; i < parks.length; i++)
      expect(parks[i]! - parks[i - 1]!).toBeGreaterThanOrEqual(SETTLE - 10);
    expect(waiting.starts.map((s) => s.sessionId)).toEqual(['w-1']);
    // Nothing running was parked: every park was an offered idle session.
    expect(hosts.reduce((sum, h) => sum + h.awakeCount, 0)).toBe(14);
  });

  it('start waits count for the limits but are never given room by the list', async () => {
    const { valve, now } = valveWith({ cap: 5 });
    const a = link('a');
    const ca = valve.connect(a);
    ca.wait(wait('m1', 's1', now(), 'start'));
    await valve.tick();
    expect(a.starts).toEqual([]);
    // And they don't make a new start wait behind them.
    ok(await valve.connect(link('b')).admit('b-1', 'message'));
  });
});

describe('BoxValve: shedding', () => {
  it('tells the guard while it sheds, and stops after 15 parks in one go', async () => {
    let usage = 0.95 * LIMIT;
    const shedding: boolean[] = [];
    const valve = new BoxValve({
      limit: LIMIT,
      readUsage: async () => usage,
      settleMs: 0,
      cap: 100,
      onShedding: (on) => shedding.push(on),
      log: quiet,
    });
    const a = link('a');
    a.idleList = Array.from({ length: 30 }, (_, i) => ({
      sessionId: `s${i}`,
      idleSinceMs: i,
      duplicate: false,
    }));
    valve.connect(a);
    await valve.check();
    // The reading never falls: it gives up at 15, and the guard is the backstop.
    expect(a.parked.length).toBe(15);
    expect(shedding).toEqual([true, false]);
    usage = 0.5 * LIMIT;
  });
});

describe('BoxValve: wait-list events for the live status', () => {
  /** The same wait-list story as above, run with a given listener. */
  async function story(onEvent?: (event: ValveEvent) => void) {
    const { valve, now, advance } = valveWith({ cap: 1, ...(onEvent ? { onEvent } : {}) });
    const a = link('agent-aaaa-1111');
    const b = link('agent-bbbb-2222');
    a.awakeCount = 1;
    const ca = valve.connect(a);
    const cb = valve.connect(b);
    const answers = [
      ca.wait(wait('m1', 'session-a-2-long-id', now())),
      ca.wait(wait('m1', 'session-a-2-long-id', now())),
      cb.wait(wait('m2', 'session-b-1-long-id', now())),
    ];
    for (let i = 0; i < 10; i++) answers.push(cb.wait(wait(`x${i}`, `b-${i}`, now())));
    a.awakeCount = 0;
    await valve.tick();
    advance(10 * 60_000);
    await valve.tick();
    return {
      answers,
      aStarts: a.starts.map((s) => s.sessionId),
      bLetGos: b.letGos,
      status: valve.status(),
    };
  }

  it('tells of waits, grants and let-gos, with ids cut to 8 and reason codes only', async () => {
    const events: ValveEvent[] = [];
    await story((event) => events.push(event));
    expect(events.slice(0, 2)).toEqual([
      { kind: 'wait', agent: 'agent-aa', conversation: 'session-', reason: null },
      { kind: 'wait', agent: 'agent-bb', conversation: 'session-', reason: null },
    ]);
    // The re-sent wait for m1 (`already`) is not a new wait.
    expect(events.filter((e) => e.kind === 'wait')).toHaveLength(11);
    expect(events).toContainEqual({
      kind: 'let_go',
      agent: 'agent-bb',
      conversation: 'b-9',
      reason: 'agent_full',
    });
    expect(events).toContainEqual({
      kind: 'granted',
      agent: 'agent-aa',
      conversation: 'session-',
      reason: null,
    });
    expect(
      events.filter((e) => e.kind === 'let_go' && e.reason === 'timed_out').length
    ).toBeGreaterThan(0);
  });

  it('tells of a wait once: a reconnect’s hello re-sending it is not a new wait', () => {
    const events: ValveEvent[] = [];
    const { valve, now } = valveWith({ cap: 1, onEvent: (event) => events.push(event) });
    const a = link('agent-aaaa-1111');
    a.awakeCount = 1;
    const first = valve.connect(a);
    expect(first.wait(wait('m1', 'session-a-1', now()))).toBe('waiting');
    first.close();
    const again = valve.connect(a);
    expect(again.hello([wait('m1', 'session-a-1', now())])).toEqual(['waiting']);
    expect(events.filter((event) => event.kind === 'wait')).toHaveLength(1);
  });

  it('catches a listener’s rejected promise', async () => {
    const rejected: Promise<void>[] = [];
    const { valve, now } = valveWith({
      cap: 1,
      onEvent: (() => {
        const promise = Promise.reject(new Error('async listener broke'));
        rejected.push(promise);
        return promise;
      }) as unknown as (event: ValveEvent) => void,
    });
    const a = link('agent-aaaa-1111');
    a.awakeCount = 1;
    expect(valve.connect(a).wait(wait('m1', 'session-a-1', now()))).toBe('waiting');
    // Settled with nothing left unhandled (vitest fails a run on an unhandled rejection).
    await Promise.allSettled(rejected);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('decides exactly the same with no listener, a listener, and one that throws', async () => {
    const without = await story();
    const withListener = await story(() => {});
    const throwing = await story(() => {
      throw new Error('listener broke');
    });
    expect(withListener).toEqual(without);
    expect(throwing).toEqual(without);
  });
});

describe('BoxValve: a failed memory reading fails closed', () => {
  /** A valve whose readings come from `readings` in turn (a number is a fraction of the limit, null a failed read). */
  function scripted(readings: (number | null)[], over: Partial<BoxValveOptions> = {}) {
    const lines: { level: 'info' | 'warn'; text: string }[] = [];
    let last: number | null = null;
    const valve = new BoxValve({
      limit: LIMIT,
      readUsage: async () => {
        if (readings.length) last = readings.shift() as number | null;
        return last === null ? null : last * LIMIT;
      },
      settleMs: 0,
      cap: 100,
      log: {
        info: (text: string) => lines.push({ level: 'info', text }),
        warn: (text: string) => lines.push({ level: 'warn', text }),
      },
      ...over,
    });
    const a = link('a');
    a.idleList = Array.from({ length: 10 }, (_, i) => ({
      sessionId: `s${i}`,
      idleSinceMs: i,
      duplicate: false,
    }));
    const conn = valve.connect(a);
    return { valve, a, conn, lines, readings };
  }
  const texts = (lines: { text: string }[], start: string) =>
    lines.filter((l) => l.text.startsWith(start));

  it('a failed reading after a park neither ends the shed silently nor parks on it', async () => {
    // 85%: park; then a failed read; then 70%: park; then 60%: under, done.
    const { valve, a, lines } = scripted([0.85, 0.85, null, 0.7, 0.6]);
    await valve.check();
    expect(a.parked).toEqual(['s0', 's1']);
    expect(texts(lines, "The box valve could not read this box's memory")).toHaveLength(1);
    expect(texts(lines, "The box valve can read this box's memory again")).toHaveLength(1);
    expect(texts(lines, 'Memory shed done:').map((l) => l.text)).toEqual([
      'Memory shed done: 2 parks, the box is at 60% (under the stop line).',
    ]);
  });

  it(`after ${SHED_UNREADABLE_SETTLES} failed readings the shed stops with a warning, and starts stay refused until a reading returns`, async () => {
    const { valve, a, conn, lines, readings } = scripted([
      0.85,
      0.85,
      ...Array<null>(SHED_UNREADABLE_SETTLES).fill(null),
    ]);
    await valve.check();
    expect(a.parked).toEqual(['s0']);
    expect(texts(lines, 'Memory shed stopped: no reading')).toHaveLength(1);
    expect(texts(lines, 'Memory shed done:').map((l) => l.text)).toEqual([
      "Memory shed done: 1 parks, the box's memory can't be read.",
    ]);
    // Still failing: refused for memory, and never taken as room.
    expect(await conn.admit('new-1', 'message')).toEqual({ ok: false, reason: 'memory' });
    expect(await conn.admit('new-2', 'message')).toEqual({ ok: false, reason: 'memory' });
    // One warning for the whole run of failures.
    expect(texts(lines, "The box valve could not read this box's memory")).toHaveLength(1);
    // A good reading lets starts in again, with one line.
    readings.push(0.5);
    ok(await conn.admit('new-3', 'message'));
    expect(texts(lines, "The box valve can read this box's memory again")).toHaveLength(1);
  });

  it('a shed whose first decision cannot read memory reads again a settle later, and carries on', async () => {
    // Started at 85%; its first read fails, the last good one (85%) is over the line, so it reads again.
    const { valve, a, lines } = scripted([0.85, null, 0.85, 0.6]);
    await valve.check();
    expect(a.parked).toEqual(['s0']);
    expect(texts(lines, 'Memory shed done:').map((l) => l.text)).toEqual([
      'Memory shed done: 1 parks, the box is at 60% (under the stop line).',
    ]);
  });

  it('admits are refused for memory on a failed reading once the box has given a good one', async () => {
    const { conn, readings } = scripted([0.5]);
    ok(await conn.admit('a-1', 'message'));
    readings.push(null);
    expect(await conn.admit('a-2', 'message')).toEqual({ ok: false, reason: 'memory' });
    readings.push(0.5);
    ok(await conn.admit('a-3', 'message'));
  });

  it('a box that has never given a reading is unchanged: flagged once, not held for memory, and reported as unprotected', async () => {
    const { valve, conn, lines } = scripted([null]);
    expect(valve.memoryProblem).toBeNull();
    for (let i = 0; i < 5; i++) ok(await conn.admit(`s${i}`, 'message'));
    expect(texts(lines, "The box valve can't read this box's memory use")).toHaveLength(1);
    expect(texts(lines, "The box valve could not read this box's memory")).toHaveLength(0);
    // Never quiet. The controller reports it to Core.
    expect(valve.memoryProblem).toBe('unprotected');
    expect(valve.memoryProtected).toBe(false);
  });

  it('is protected once the box has given a good reading, and stays so through a failing run', async () => {
    const { valve, conn, readings } = scripted([0.5]);
    expect(valve.memoryProtected).toBe(false);
    ok(await conn.admit('a-1', 'message'));
    expect(valve.memoryProtected).toBe(true);
    readings.push(null);
    await conn.admit('a-2', 'message');
    // Failing closed is still protecting: starts wait.
    expect(valve.memoryProtected).toBe(true);
  });

  it('reports a run of failed readings as failing, and nothing once readings are fine', async () => {
    const { valve, conn, readings } = scripted([0.5]);
    ok(await conn.admit('a-1', 'message'));
    expect(valve.memoryProblem).toBeNull();
    readings.push(null);
    await conn.admit('a-2', 'message');
    expect(valve.memoryProblem).toBe('failing');
    readings.push(0.5);
    ok(await conn.admit('a-3', 'message'));
    expect(valve.memoryProblem).toBeNull();
  });

  it('the shed-done line says the reading after the shed, with its reason from a fixed set', async () => {
    const limit = scripted([0.95, ...Array<number>(20).fill(0.95)]);
    await limit.valve.check();
    expect(texts(limit.lines, 'Memory shed done:').map((l) => l.text)).toEqual([
      'Memory shed done: 10 parks, the box is at 95% (no idle session left).',
    ]);
    const all = [...Array<number>(40).fill(0.95)];
    const many = scripted(all);
    many.a.idleList = Array.from({ length: 30 }, (_, i) => ({
      sessionId: `t${i}`,
      idleSinceMs: i,
      duplicate: false,
    }));
    await many.valve.check();
    expect(texts(many.lines, 'Memory shed done:').map((l) => l.text)).toEqual([
      'Memory shed done: 15 parks, the box is at 95% (the park limit).',
    ]);
  });

  it('at the park limit the closing line gives the reading after the 15th park, not before it', async () => {
    // 95% for the check and the 15 decisions, then 88% after the 15th park.
    const { valve, a, lines } = scripted([...Array<number>(16).fill(0.95), 0.88]);
    a.idleList = Array.from({ length: 30 }, (_, i) => ({
      sessionId: `u${i}`,
      idleSinceMs: i,
      duplicate: false,
    }));
    await valve.check();
    expect(a.parked).toHaveLength(15);
    expect(texts(lines, 'Memory shed done:').map((l) => l.text)).toEqual([
      'Memory shed done: 15 parks, the box is at 88% (the park limit).',
    ]);
  });

  it('a shed that ends in an error says so in its own fixed line, never "the park limit"', async () => {
    const lines: string[] = [];
    const valve = new BoxValve({
      limit: LIMIT,
      readUsage: async () => 0.95 * LIMIT,
      settleMs: 0,
      cap: 100,
      log: {
        // The first park's own line throws, which breaks the shed's loop.
        info: (text: string) => {
          if (text.startsWith('Parking session')) throw new Error('log broke');
          lines.push(text);
        },
        warn: (text: string) => void lines.push(text),
      },
    });
    const a = link('a');
    a.idleList = [{ sessionId: 's0', idleSinceMs: 0, duplicate: false }];
    valve.connect(a);
    await valve.check().catch(() => undefined);
    expect(lines.filter((t) => t.startsWith('Memory shed done:'))).toEqual([
      'Memory shed done: 1 parks, stopped by an error.',
    ]);
  });
});
