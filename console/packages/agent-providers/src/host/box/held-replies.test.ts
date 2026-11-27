import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HELD_REPLY_LIMIT, HeldReplies, OwedLostLines, type ResendOutcome } from './held-replies';

afterEach(() => {
  vi.useRealTimers();
});

const quiet = () => ({ info: vi.fn(), warn: vi.fn() });

/**
 * Switch away from `t0` until `back` ms later, as a Core redeploy leaves it:
 * box A, 27 Oct, no Switch serving from 07:54:24.9 to 07:54:39 (about 12 s
 * after the agent's post at 07:54:27.186).
 */
function awayFor(back: number, t0: number) {
  const tries: number[] = [];
  const resend = async (): Promise<ResendOutcome> => {
    tries.push(Date.now() - t0);
    return Date.now() - t0 >= back
      ? { kind: 'posted' }
      : { kind: 'unavailable', detail: 'fetch failed: connect ECONNREFUSED' };
  };
  return { tries, resend };
}

const entry = (key: string, resend: () => Promise<ResendOutcome>) => ({
  key,
  sessionId: 'session-1',
  roomId: 'room-1',
  threadId: 'thread-1',
  tool: 'post_message',
  args: { body: 'the reply' },
  resend,
});

it.each([
  ['the 07:54 window (about 12 s)', 12_000],
  ['a 15 s outage', 15_000],
])('posts a held reply once Switch is back after %s, on the timer alone', async (_name, back) => {
  vi.useFakeTimers();
  const t0 = Date.now();
  const log = quiet();
  const held = new HeldReplies({ log });
  const switchCore = awayFor(back, t0);

  expect(held.hold(entry('reply:k1', switchCore.resend))).toBe(true);
  await vi.advanceTimersByTimeAsync(back + 31_000);

  expect(held.size).toBe(0);
  // Posted on the first try after Switch came back, then never tried again.
  const posted = switchCore.tries.findIndex((at) => at >= back);
  expect(posted).toBe(switchCore.tries.length - 1);
  expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/^Posted held reply reply:k1 /));
});

it('tries at once when Switch is back, rather than waiting for the next timer', async () => {
  vi.useFakeTimers();
  const t0 = Date.now();
  const held = new HeldReplies({ log: quiet() });
  const switchCore = awayFor(12_000, t0);
  held.hold(entry('reply:k1', switchCore.resend));

  await vi.advanceTimersByTimeAsync(12_000);
  const before = switchCore.tries.length;
  held.retryNow();
  await vi.advanceTimersByTimeAsync(0);

  expect(switchCore.tries.length).toBe(before + 1);
  expect(held.size).toBe(0);
});

it('gives up after the 10-minute window with Switch still away, and says so once', async () => {
  vi.useFakeTimers();
  const t0 = Date.now();
  const log = quiet();
  const held = new HeldReplies({ log });
  const switchCore = awayFor(Number.POSITIVE_INFINITY, t0);
  held.hold(entry('reply:k1', switchCore.resend));

  await vi.advanceTimersByTimeAsync(30 * 60_000);

  expect(held.size).toBe(0);
  expect(switchCore.tries.at(-1)).toBe(600_000);
  expect(switchCore.tries.every((at) => at <= 600_000)).toBe(true);
  // Backed off to a try a minute.
  expect(switchCore.tries.slice(0, 7)).toEqual([
    2_000, 6_000, 14_000, 29_000, 59_000, 119_000, 179_000,
  ]);
  const gaveUp = log.warn.mock.calls.filter(([line]) => String(line).startsWith('Gave up'));
  expect(gaveUp).toHaveLength(1);
  expect(String(gaveUp[0]![0])).toContain('It was not posted');
});

it('stops trying a held reply Switch refuses', async () => {
  vi.useFakeTimers();
  const log = quiet();
  const held = new HeldReplies({ log });
  const resend = vi.fn(async (): Promise<ResendOutcome> => ({
    kind: 'final',
    detail: '403: not a member',
  }));
  held.hold(entry('reply:k1', resend));

  await vi.advanceTimersByTimeAsync(120_000);

  expect(resend).toHaveBeenCalledTimes(1);
  expect(held.size).toBe(0);
  expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining('403: not a member'));
});

it('loses what it holds when its process stops, and logs that once, by key', async () => {
  vi.useFakeTimers();
  const log = quiet();
  const held = new HeldReplies({ log });
  const resend = vi.fn(async (): Promise<ResendOutcome> => ({
    kind: 'unavailable',
    detail: 'away',
  }));
  held.hold(entry('reply:k1', resend));
  held.hold({ ...entry('reply:k2', resend), sessionId: 'session-2' });

  held.stop();
  held.stop();
  await vi.advanceTimersByTimeAsync(120_000);

  expect(resend).not.toHaveBeenCalled();
  const lost = log.warn.mock.calls.filter(([line]) => String(line).startsWith('Stopping with'));
  expect(lost).toHaveLength(1);
  expect(String(lost[0]![0])).toContain('reply:k1 (session session-1, room room-1)');
  expect(String(lost[0]![0])).toContain('reply:k2 (session session-2, room room-1)');
  expect(String(lost[0]![0])).not.toContain('the reply');
  expect(held.hold(entry('reply:k3', resend))).toBe(false);
});

it('finds a post already held for the same session and arguments', () => {
  const held = new HeldReplies({ log: quiet() });
  const resend = async (): Promise<ResendOutcome> => ({ kind: 'unavailable', detail: 'away' });
  held.hold(entry('reply:k1', resend));

  expect(held.heldLike('session-1', 'post_message', { body: 'the reply' })?.key).toBe('reply:k1');
  expect(held.heldLike('session-2', 'post_message', { body: 'the reply' })).toBeNull();
  expect(held.heldLike('session-1', 'post_message', { body: 'another' })).toBeNull();
  held.stop();
});

it('holds at most a bounded number of posts', () => {
  const held = new HeldReplies({ log: quiet() });
  const resend = async (): Promise<ResendOutcome> => ({ kind: 'unavailable', detail: 'away' });
  for (let i = 0; i < HELD_REPLY_LIMIT; i++)
    expect(held.hold(entry(`reply:k${i}`, resend))).toBe(true);
  expect(held.hold(entry('reply:over', resend))).toBe(false);
  held.stop();
});

it('sends a reply given up on once more under its key when Switch is back, and adds no lost line', async () => {
  // Switch may already hold the reply (an answer cut off);
  // the keyed send is then that reply, and a "lost" line would contradict it.
  vi.useFakeTimers();
  const t0 = Date.now();
  const log = quiet();
  const held = new HeldReplies({ log });
  const back = 15 * 60_000;
  const switchCore = awayFor(back, t0);
  const tellLost = vi.fn(async (): Promise<ResendOutcome> => ({ kind: 'posted' }));
  held.hold({ ...entry('reply:k1', switchCore.resend), tellLost });

  await vi.advanceTimersByTimeAsync(back);
  held.retryNow();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(tellLost).not.toHaveBeenCalled();
  expect(held.size).toBe(0);
  expect(switchCore.tries.filter((at) => at >= back)).toHaveLength(1);
  expect(log.info).toHaveBeenCalledWith(expect.stringContaining('after it was given up on'));
});

it.each([
  ['inside the window', 30_000],
  ['after giving up', 15 * 60_000],
])('tells the room once that a reply was lost when Switch refuses it %s', async (_name, back) => {
  // "Held", then refused, must not end in silence.
  vi.useFakeTimers();
  const t0 = Date.now();
  const log = quiet();
  const held = new HeldReplies({ log });
  const resend = vi.fn(async (): Promise<ResendOutcome> =>
    Date.now() - t0 >= back
      ? { kind: 'final', detail: 'Switch answered 403' }
      : { kind: 'unavailable', detail: 'Switch could not be reached' }
  );
  const tellLost = vi.fn(async (): Promise<ResendOutcome> => ({ kind: 'posted' }));
  held.hold({ ...entry('reply:k1', resend), tellLost });

  await vi.advanceTimersByTimeAsync(back);
  held.retryNow();
  await vi.advanceTimersByTimeAsync(120_000);

  expect(tellLost).toHaveBeenCalledTimes(1);
  expect(held.size).toBe(0);
  // The reply itself is not tried again once Switch has refused it.
  const refusals = await Promise.all(resend.mock.results.map((r) => r.value));
  expect(refusals.filter((o) => o.kind === 'final')).toHaveLength(1);
  expect(log.info).toHaveBeenCalledWith(
    expect.stringMatching(/^Told room room-1 that held reply reply:k1 /)
  );
});

it('does not count lines owed for given-up posts toward the limit', async () => {
  vi.useFakeTimers();
  const held = new HeldReplies({ log: quiet() });
  const away = async (): Promise<ResendOutcome> => ({ kind: 'unavailable', detail: 'away' });
  for (let i = 0; i < HELD_REPLY_LIMIT; i++)
    held.hold({ ...entry(`reply:k${i}`, away), tellLost: away });
  await vi.advanceTimersByTimeAsync(600_000);
  // All 50 now only owe a line: new posts can still be held.
  expect(held.size).toBe(HELD_REPLY_LIMIT);
  expect(held.hold(entry('reply:new', away))).toBe(true);
  held.stop();
});

it('logs, and says nothing, when Switch stays away past the lost-line window', async () => {
  vi.useFakeTimers();
  const log = quiet();
  const held = new HeldReplies({ log });
  const away = async (): Promise<ResendOutcome> => ({ kind: 'unavailable', detail: 'away' });
  held.hold({ ...entry('reply:k1', away), tellLost: away });

  await vi.advanceTimersByTimeAsync(600_000 + 31 * 60_000);

  expect(held.size).toBe(0);
  expect(log.warn).toHaveBeenLastCalledWith(
    expect.stringMatching(/^Could not tell room room-1 that held reply reply:k1 /)
  );
});

describe('a restart while holding', () => {
  const key = (n: number) => `reply:0000000${n}-0000-4000-8000-000000000000`;

  it('records where each held post is owed a line, never what it said', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'held-replies-'));
    try {
      const path = join(dir, 'held-replies.json');
      const owed = await OwedLostLines.open(path);
      const held = new HeldReplies({ log: quiet(), owed });
      const away = async (): Promise<ResendOutcome> => ({ kind: 'unavailable', detail: 'away' });
      held.hold({ ...entry(key(1), away), args: { body: 'a secret reply' } });
      await vi.waitFor(async () =>
        expect(JSON.parse(await readFile(path, 'utf8')).owed).toHaveLength(1)
      );
      const text = await readFile(path, 'utf8');
      expect(text).not.toContain('a secret reply');
      expect(JSON.parse(text).owed[0]).toMatchObject({
        key: key(1),
        sessionId: 'session-1',
        roomId: 'room-1',
        threadId: 'thread-1',
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      // Stopping keeps the record, so the next start tells the room.
      held.stop();
      expect((await OwedLostLines.open(path)).fromBefore.map((line) => line.key)).toEqual([key(1)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tells each room once, after the restart, as soon as Switch answers, and clears the record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'held-replies-'));
    try {
      const path = join(dir, 'held-replies.json');
      const before = await OwedLostLines.open(path);
      await before.save([
        {
          key: key(1),
          sessionId: 'session-1',
          roomId: 'room-1',
          threadId: 'thread-1',
          heldAt: Date.now(),
        },
      ]);
      const owed = await OwedLostLines.open(path);
      const log = quiet();
      const held = new HeldReplies({ log, owed, lostRetryMs: 10_000 });
      const switchUp = { now: false };
      const told: string[] = [];
      held.owedFromBefore(owed.fromBefore, (line) => async () => {
        if (!switchUp.now) return { kind: 'unavailable', detail: 'away' };
        told.push(`${line.roomId}/${line.threadId}`);
        return { kind: 'posted' };
      });
      switchUp.now = true;
      held.retryNow();
      await vi.waitFor(() => expect(held.size).toBe(0));
      held.retryNow();
      await held.settled();

      expect(told).toEqual(['room-1/thread-1']);
      expect(log.info).toHaveBeenCalledWith(
        expect.stringMatching(/^Told room room-1 that held reply/)
      );
      await vi.waitFor(async () =>
        expect(JSON.parse(await readFile(path, 'utf8')).owed).toEqual([])
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('follow-ups on the record', () => {
  const key = (n: number) => `reply:0000000${n}-0000-4000-8000-000000000000`;
  const line = (n: number, heldAt: number) => ({
    key: key(n),
    sessionId: 'session-1',
    roomId: 'room-1',
    threadId: null,
    heldAt,
  });

  it('removes a write cut off before its rename, and nothing else, when the record is opened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'held-replies-'));
    try {
      const path = join(dir, 'held-replies.json');
      const leftover = `${path}.7f1c0000-0000-4000-8000-000000000001.tmp`;
      const unrelated = join(dir, 'held-replies.json.notes.tmp');
      const other = join(dir, 'placements.json.7f1c0000-0000-4000-8000-000000000001.tmp');
      for (const file of [leftover, unrelated, other]) await writeFile(file, '{}');
      await OwedLostLines.open(path);
      await expect(stat(leftover)).rejects.toMatchObject({ code: 'ENOENT' });
      // Only the record's own temporary files: anything else is left alone.
      await expect(stat(unrelated)).resolves.toBeTruthy();
      await expect(stat(other)).resolves.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips a line owed for a reply held more than 24 hours ago, and says how many', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'held-replies-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const path = join(dir, 'held-replies.json');
      const now = Date.parse('2026-10-28T12:00:00Z');
      await writeFile(
        path,
        JSON.stringify({
          owed: [
            line(1, now - 24 * 60 * 60_000 - 1),
            line(2, now - 60_000),
            line(3, now - 24 * 60 * 60_000),
          ],
        })
      );
      const owed = await OwedLostLines.open(path, () => now);
      expect(owed.fromBefore.map((l) => l.key)).toEqual([key(2), key(3)]);
      expect(warn).toHaveBeenCalledWith(
        'Skipping 1 lost-reply line(s) owed for replies held more than 24 hours ago.'
      );
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
