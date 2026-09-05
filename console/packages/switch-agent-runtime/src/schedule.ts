/**
 * When an agent acts without being spoken to.
 *
 * Everything else in Switch is a response: an event arrives and the agent
 * answers. A weekly digest, a nudge about something overdue, a brief the
 * evening before a review — none of those are answers, and nothing in the
 * protocol wakes an agent for them.
 *
 * This is deliberately client-side, and it is the whole of the mechanism. A
 * wake-up delivered when no client is connected has nobody to wake, so a
 * server-side scheduler would buy nothing the long-lived host does not already
 * need: the schedule lives in the agent's own room document beside the rest of
 * its working state, and is re-armed from there on restart.
 *
 * The two things that make it more than `setTimeout` are both about time
 * passing while nobody was listening — see `advance` and `nextDelayMs`.
 */

/**
 * The largest delay a timer can actually hold.
 *
 * Node stores it in a 32-bit signed int. Above this it overflows and the timer
 * fires **immediately** rather than late, so a monthly wake-up armed naively
 * goes off at once, reschedules, and goes off at once again — a loop that looks
 * like an agent that has lost its mind.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The shortest recurrence that can actually move a wake-up forward.
 *
 * A timer cannot honour anything finer, and below roughly 2.4e-4 ms the
 * increment is smaller than the gap between representable epoch values, so
 * adding it leaves the moment unchanged and the wake-up fires forever. Only
 * reachable from a hand-edited schedule document — which is exactly the input
 * `parseWakeups` is written to survive.
 */
export const MIN_PERIOD_MS = 1;

export interface Wakeup {
  /** Stable across restarts, so a wake-up can be replaced or cancelled. */
  id: string;
  /** Epoch milliseconds of the next firing. */
  atMs: number;
  /** What the agent is waking up to do. */
  note: string;
  /** Where to act, when that was decided in advance. */
  roomId?: string;
  /** Milliseconds between firings. Absent — or non-positive — is one-shot. */
  everyMs?: number;
}

/** The wake-ups whose moment has arrived, oldest first. */
export function due(wakeups: readonly Wakeup[], nowMs: number): Wakeup[] {
  return wakeups.filter((w) => w.atMs <= nowMs).sort((a, b) => a.atMs - b.atMs);
}

/**
 * The same wake-up at its next moment, or null if it is finished.
 *
 * Two rules, both about an agent that was not running:
 *
 * - **A missed recurrence fires once.** Advancing by a single period would
 *   leave the next moment still in the past, and the caller would fire it
 *   again immediately — an agent off for a month posting four weekly digests
 *   in a row. It skips forward to the first occurrence that is genuinely
 *   ahead instead.
 * - **Firing late does not move the slot.** The next moment is computed from
 *   the scheduled time and the period, never from the clock, so a digest due
 *   Wednesday 09:00 that ran at 09:04 is still due at 09:00 the week after
 *   rather than walking forward four minutes every week.
 */
export function advance(wakeup: Wakeup, nowMs: number): Wakeup | null {
  const period = wakeup.everyMs;
  if (period === undefined || period < MIN_PERIOD_MS) return null;

  const missed = Math.floor((nowMs - wakeup.atMs) / period) + 1;
  const atMs = wakeup.atMs + missed * period;
  // Below the ULP of a current epoch value the increment rounds away and `atMs`
  // lands on `nowMs` itself — `due` fires it, `advance` returns the same moment,
  // and it spins. The floor above prevents it; this catches anything the
  // arithmetic still cannot move forward, including a period large enough to
  // overflow to Infinity.
  if (!Number.isFinite(atMs) || atMs <= nowMs) return null;
  return { ...wakeup, atMs };
}

/** The schedule after the given wake-ups have fired. */
export function reschedule(
  wakeups: readonly Wakeup[],
  fired: readonly Wakeup[],
  nowMs: number
): Wakeup[] {
  const firedIds = new Set(fired.map((w) => w.id));
  const kept: Wakeup[] = [];
  for (const wakeup of wakeups) {
    if (!firedIds.has(wakeup.id)) {
      kept.push(wakeup);
      continue;
    }
    const next = advance(wakeup, nowMs);
    if (next !== null) kept.push(next);
  }
  return kept;
}

/**
 * How long to arm the timer for, or null when nothing is scheduled.
 *
 * Never negative — an overdue wake-up is zero, because a negative delay reads
 * as a bug in every log line that prints it — and never longer than a timer can
 * hold. A wake-up further out than the ceiling simply gets re-armed when the
 * first sleep expires.
 */
export function nextDelayMs(wakeups: readonly Wakeup[], nowMs: number): number | null {
  if (wakeups.length === 0) return null;
  // Reduced rather than spread: `Math.min(...xs)` throws RangeError somewhere
  // above 100k arguments, and it would escape into the arming loop and stop the
  // agent waking at all, without any wake-up having been wrong.
  const soonest = wakeups.reduce((lowest, w) => Math.min(lowest, w.atMs), Infinity);
  return Math.min(Math.max(soonest - nowMs, 0), MAX_TIMER_MS);
}

export function serialiseWakeups(wakeups: readonly Wakeup[]): string {
  return JSON.stringify(wakeups, null, 2);
}

/**
 * Read a schedule out of the document it lives in.
 *
 * That document is a thing a human can open and edit, so this never throws: a
 * stray character costs the schedule, loudly, rather than the agent's ability
 * to start. Entries that are not whole wake-ups are dropped individually —
 * half an entry is worse than none, since a wake-up with no moment either never
 * fires or fires constantly and neither says why.
 */
export function parseWakeups(raw: string): Wakeup[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  // Keyed by id, last one wins: two wake-ups sharing an id cannot both be
  // cancelled, and whichever the agent meant, it meant one of them.
  const byId = new Map<string, Wakeup>();
  for (const entry of parsed) {
    const wakeup = asWakeup(entry);
    if (wakeup !== null) byId.set(wakeup.id, wakeup);
  }
  return [...byId.values()];
}

function asWakeup(entry: unknown): Wakeup | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const { id, atMs, note, roomId, everyMs } = entry as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return null;
  if (typeof note !== 'string') return null;

  const wakeup: Wakeup = { id, atMs, note };
  if (typeof roomId === 'string') wakeup.roomId = roomId;
  if (typeof everyMs === 'number' && everyMs >= MIN_PERIOD_MS) wakeup.everyMs = everyMs;
  return wakeup;
}
