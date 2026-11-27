import { describe, expect, it, vi } from 'vitest';
import { type RoomWaiter, RoomWaitList } from './room-wait';

const quiet = { info: () => {}, warn: () => {} };

function list(now: { ms: number }, options: { max?: number; maxWaitMs?: number } = {}) {
  return new RoomWaitList({ now: () => now.ms, retryMs: 60_000, log: quiet, ...options });
}

function waiter(
  sessionId: string,
  messageId: string,
  sinceMs: number,
  overrides: Partial<RoomWaiter> = {}
): RoomWaiter {
  return {
    agentId: 'agent',
    sessionId,
    roomId: `room-${sessionId}`,
    messageId,
    sinceMs,
    retry: vi.fn(async () => false),
    giveUp: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('the wait-for-room list', () => {
  it('starts the oldest waiting session first, and no younger one while it still has no room', async () => {
    const now = { ms: 10_000 };
    const waits = list(now);
    const tried: string[] = [];
    let room = false;
    const retry = (id: string) => async () => {
      tried.push(id);
      return room;
    };
    // Added out of order: the list goes by when each started waiting.
    expect(waits.add(waiter('young', 'm2', 9_000, { retry: retry('young') }))).toBe('waiting');
    expect(waits.add(waiter('old', 'm1', 5_000, { retry: retry('old') }))).toBe('waiting');
    await waits.tick();
    expect(tried).toEqual(['old']);
    expect(waits.size).toBe(2);
    room = true;
    tried.length = 0;
    await waits.tick();
    expect(tried).toEqual(['old', 'young']);
    expect(waits.size).toBe(0);
  });

  it('tries a session once for all its messages, and they all leave once it starts', async () => {
    const now = { ms: 10_000 };
    const waits = list(now);
    const retry = vi.fn(async () => true);
    waits.add(waiter('s', 'm1', 1_000, { retry }));
    waits.add(waiter('s', 'm2', 2_000, { retry }));
    waits.add(waiter('s', 'm3', 3_000, { retry }));
    await waits.tick();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(waits.size).toBe(0);
  });

  it('lets go of a message after 10 minutes, and keeps the younger ones waiting', async () => {
    const now = { ms: 0 };
    const waits = list(now);
    const old = waiter('a', 'm1', 0);
    const young = waiter('b', 'm2', 5 * 60_000);
    waits.add(old);
    waits.add(young);
    now.ms = 10 * 60_000 - 1;
    await waits.tick();
    expect(old.giveUp).not.toHaveBeenCalled();
    now.ms = 10 * 60_000;
    await waits.tick();
    expect(old.giveUp).toHaveBeenCalledWith('timed out');
    expect(young.giveUp).not.toHaveBeenCalled();
    expect(waits.has('agent', 'room-b', 'm2')).toBe(true);
    expect(waits.size).toBe(1);
  });

  it('refuses a 21st message, and one that already waited its limit (after a restart)', () => {
    const now = { ms: 20 * 60_000 };
    const waits = list(now);
    for (let i = 0; i < 20; i++)
      expect(waits.add(waiter(`s${i}`, `m${i}`, now.ms - i))).toBe('waiting');
    expect(waits.add(waiter('s20', 'm20', now.ms))).toBe('full');
    expect(waits.size).toBe(20);
    // The same message again is not a second one.
    expect(waits.add(waiter('s0', 'm0', now.ms))).toBe('already');
    waits.removeWhere((entry) => entry.sessionId === 's0');
    expect(waits.add(waiter('late', 'm-late', now.ms - 10 * 60_000))).toBe('expired');
  });

  it('counts each agent apart, with its oldest message, across every agent in the box', () => {
    const now = { ms: Date.parse('2026-10-27T12:00:00Z') };
    const waits = list(now, { max: 3 });
    waits.add(waiter('a1', 'm1', now.ms - 60_000));
    waits.add(waiter('a2', 'm2', now.ms - 30_000));
    waits.add(waiter('b1', 'm3', now.ms, { agentId: 'other' }));
    expect(waits.count('agent')).toEqual({ count: 2, oldestSince: '2026-10-27T11:59:00.000Z' });
    expect(waits.count('other')).toEqual({ count: 1, oldestSince: '2026-10-27T12:00:00.000Z' });
    expect(waits.count('nobody')).toEqual({ count: 0, oldestSince: null });
    // The limit is the box's, not each agent's.
    expect(waits.add(waiter('b2', 'm4', now.ms, { agentId: 'other' }))).toBe('full');
    expect(waits.sessionsOf('agent').sort()).toEqual(['a1', 'a2']);
  });

  it('tells listeners which agent changed, and takes messages off without a line', () => {
    const now = { ms: 0 };
    const waits = list(now);
    const changed: string[] = [];
    waits.onChange((agentId) => changed.push(agentId));
    const kept = waiter('s', 'm1', 0, { host: 'run-1' });
    waits.add(kept);
    waits.add(waiter('t', 'm2', 0, { agentId: 'other', host: 'run-2' }));
    const removed = waits.removeWhere((entry) => entry.host === 'run-1');
    expect(removed).toEqual([kept]);
    expect(kept.giveUp).not.toHaveBeenCalled();
    expect(changed).toEqual(['agent', 'other', 'agent']);
    expect(waits.waitingFor('s')).toBe(false);
    expect(waits.waitingFor('t')).toBe(true);
  });

  it('steps over a session whose start throws, so the ones behind it still start', async () => {
    // A broken oldest session held every other message until its
    // limit, and they were let go with "couldn't get room" while there was room.
    const now = { ms: 0 };
    const warn = vi.fn();
    const waits = new RoomWaitList({ now: () => now.ms, log: { info: () => {}, warn } });
    const younger = vi.fn(async () => true);
    waits.add(
      waiter('a', 'm1', 0, {
        retry: async () => {
          throw new Error('host would not start');
        },
      })
    );
    waits.add(waiter('b', 'm2', 1, { retry: younger }));
    waits.add(waiter('c', 'm3', 2, { retry: async () => false }));
    await waits.tick();
    // The broken one stays, tried again next round and let go at its limit.
    expect(younger).toHaveBeenCalledTimes(1);
    expect(waits.has('agent', 'room-a', 'm1')).toBe(true);
    expect(waits.has('agent', 'room-b', 'm2')).toBe(false);
    // Still "oldest first" for the rest: no room for c, so it waits.
    expect(waits.has('agent', 'room-c', 'm3')).toBe(true);
    expect(warn.mock.calls.some(([line]) => String(line).includes('host would not start'))).toBe(
      true
    );
  });

  it('retries a session that failed to start at its own pace, and never lets it hold up room waits', async () => {
    const now = { ms: 0 };
    const waits = new RoomWaitList({ now: () => now.ms, startRetryMs: 30_000, log: quiet });
    const broken = vi.fn(async () => false);
    const roomy = vi.fn(async () => true);
    // The failed start is older, and still never stands in the room queue.
    waits.add(waiter('failed', 'm1', 0, { kind: 'start', retry: broken }));
    waits.add(waiter('full', 'm2', 1, { retry: roomy }));
    expect(waits.waitingForRoom).toBe(1);
    expect(waits.count('agent')).toEqual({ count: 1, oldestSince: new Date(1).toISOString() });
    expect(waits.count('agent', 'start').count).toBe(1);
    await waits.tick();
    // Just failed: its first retry is a full interval on. The room wait starts.
    expect(broken).not.toHaveBeenCalled();
    expect(roomy).toHaveBeenCalledTimes(1);
    now.ms = 29_999;
    await waits.tick();
    expect(broken).not.toHaveBeenCalled();
    now.ms = 30_000;
    await waits.tick();
    expect(broken).toHaveBeenCalledTimes(1);
    now.ms = 40_000;
    await waits.tick();
    expect(broken).toHaveBeenCalledTimes(1);
    // It shares the limits: let go at 10 minutes like any other.
    now.ms = 10 * 60_000;
    await waits.tick();
    expect(waits.size).toBe(0);
  });

  it('retries a person-fixable failure on its slow clock, and at once when hurried', async () => {
    const now = { ms: 0 };
    const waits = new RoomWaitList({ now: () => now.ms, startRetryMs: 30_000, log: quiet });
    const retry = vi.fn(async () => false);
    waits.add(waiter('s', 'm', 0, { kind: 'start', retryEveryMs: 120_000, retry }));
    await waits.tick();
    now.ms = 60_000;
    await waits.tick();
    expect(retry).not.toHaveBeenCalled();
    // The login lands (the definition is replaced): tried now, not in another minute.
    await waits.hurry(() => true);
    expect(retry).toHaveBeenCalledTimes(1);
    now.ms = 61_000;
    await waits.tick();
    expect(retry).toHaveBeenCalledTimes(1);
    now.ms = 181_000;
    await waits.tick();
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('counts failed starts towards the box limit of waiting messages', () => {
    const now = { ms: 0 };
    const waits = list(now, { max: 2 });
    waits.add(waiter('a', 'm1', 0, { kind: 'start' }));
    waits.add(waiter('b', 'm2', 0));
    expect(waits.add(waiter('c', 'm3', 0))).toBe('full');
  });

  it('runs one round at a time', async () => {
    const now = { ms: 0 };
    const waits = list(now);
    let release: () => void = () => {};
    const retry = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        })
    );
    waits.add(waiter('s', 'm', 0, { retry }));
    const first = waits.tick();
    const second = waits.tick();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    release();
    await first;
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('retries on its own every few seconds while anything waits', async () => {
    vi.useFakeTimers();
    try {
      const waits = new RoomWaitList({ retryMs: 5_000, log: quiet });
      const retry = vi.fn(async () => false);
      waits.add(waiter('s', 'm', Date.now(), { retry }));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(retry).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(retry).toHaveBeenCalledTimes(2);
      waits.removeWhere(() => true);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(retry).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
