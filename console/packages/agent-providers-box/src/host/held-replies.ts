/**
 * Room posts an agent made while Switch was away, held to be sent again once
 * it is back.
 *
 * Box A, 27 Oct 07:54: an agent's `post_message` ran at 07:54:27.186, while no
 * Switch was serving (the old one stopped by 07:54:24.9, the new one answered
 * from 07:54:39). The call failed, the turn ended "completed", and the reply
 * never reached the room. Every Switch release opens that window.
 *
 * Every post the agent's host makes carries its own key (`reply:<uuid>`), and
 * Switch posts once per key for the agent. So a post sent again, even one
 * whose first try Switch did make but whose answer was lost, is never a second
 * copy. A held post is kept in this process's memory only, never on disk: if
 * the process stops first, the post is lost, and that is logged once.
 *
 * What is written down is only that a line is owed: the key, session, room,
 * thread and time of each held post (`OwedLostLines`), never what it said. A
 * process that starts and finds one tells that room its reply was lost, once
 * Switch answers: a restart while holding is otherwise a
 * silent loss.
 */

import { randomUUID } from 'node:crypto';
import { open, readdir, readFile, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { replaceFile } from './replace-file';

/** How long a post is held before it is given up on. */
export const HELD_REPLY_WINDOW_MS = 10 * 60_000;

/** The waits between tries, after which the last one repeats until the window ends. */
export const HELD_REPLY_RETRY_MS = [2_000, 4_000, 8_000, 15_000, 30_000, 60_000];

/**
 * How long, after a held post is given up on, the room's line saying it was
 * lost is tried (each `HELD_REPLY_LOST_RETRY_MS`, and at once when Switch is
 * back). Past it, nothing more is tried and that is logged.
 */
export const HELD_REPLY_LOST_WINDOW_MS = 30 * 60_000;
export const HELD_REPLY_LOST_RETRY_MS = 30_000;

/** A line owed from before a restart is skipped once its reply was held longer ago than this. */
export const OWED_LINE_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * At most this many posts are held at once (lines owed for posts given up on
 * don't count); past it a failed post fails to the agent as before.
 */
export const HELD_REPLY_LIMIT = 50;

/** What the agent is told in place of the failed post: not to send it again. */
export const HELD_REPLY_NOTICE =
  "Switch is restarting, so your message hasn't reached the room yet. It's held and will be posted as soon as Switch is back. Don't post it again yourself.";

/**
 * What the room is told, in the lost post's thread, once Switch is back after
 * a held post was given up on: no lost reply goes unsaid.
 */
export const HELD_REPLY_LOST_LINE =
  "I wrote a reply while Switch was restarting, but it couldn't be delivered in time and was lost. Please send your message again.";

/** The room-posting tools whose failed posts are held. */
export const HELD_TOOLS = new Set(['post_message', 'send_targeted_message']);

export type HeldReply = {
  /** The key the post was first tried under, and is sent again under. */
  key: string;
  sessionId: string;
  /** The room the session attended when it posted: the post goes nowhere else. */
  roomId: string;
  /** The thread it was posted in, where a line saying it was lost goes too. */
  threadId: string | null;
  tool: string;
  args: Record<string, unknown>;
  heldAt: number;
  /** Sends it again, under the same key, as the session that made it. */
  resend: () => Promise<ResendOutcome>;
  /** Tells the room it was lost (`HELD_REPLY_LOST_LINE`), once, under a key of its own. */
  tellLost?: () => Promise<ResendOutcome>;
};

/**
 * A held post, or the line owed for one given up on. `unsendable` once the
 * post itself can't be sent again (Switch refused it, or its text went with
 * a restart): only the line is left to try.
 */
type Entry = HeldReply & { phase: 'reply' | 'lost'; deadline: number; unsendable?: boolean };

/** An error's name or code for a log: never its message, which can carry a path. */
function errorName(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.name : 'unknown error';
}

/** What is written down for each held post: where its line is owed, never its text. */
const owedLineSchema = z.strictObject({
  key: z.string().regex(/^reply:[0-9a-f-]{36}$/),
  sessionId: z.string().min(1).max(200),
  roomId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200).nullable(),
  heldAt: z.number().int().nonnegative(),
});
export type OwedLine = z.infer<typeof owedLineSchema>;

/**
 * The held posts of the process that ran before, as `OwedLine`s, in one file
 * (0600, replaced whole). Read once at start; what it lists was lost with that
 * process, and each room is owed its line.
 */
export class OwedLostLines {
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    readonly fromBefore: OwedLine[]
  ) {}

  static async open(path: string, now: () => number = Date.now): Promise<OwedLostLines> {
    // A write cut off before its rename leaves its temporary file behind
    // (`<record>.<uuid>.tmp`); the record itself is whole, so the leftover
    // only goes.
    const base = `${basename(path)}.`;
    try {
      for (const name of await readdir(dirname(path)))
        if (
          name.startsWith(base) &&
          name.endsWith('.tmp') &&
          /^[0-9a-f-]{36}$/.test(name.slice(base.length, -'.tmp'.length))
        )
          await unlink(join(dirname(path), name)).catch(() => {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn(`Could not clear leftover held-reply records: ${errorName(error)}`);
    }
    let fromBefore: OwedLine[] = [];
    try {
      const parsed = z
        .object({ owed: z.array(owedLineSchema) })
        .safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (parsed.success) {
        // A line owed for a reply held more than a day ago is skipped, with a
        // count: a room told a day late of a lost reply learns nothing useful.
        const recent = parsed.data.owed.filter(
          (line) => now() - line.heldAt <= OWED_LINE_MAX_AGE_MS
        );
        if (recent.length < parsed.data.owed.length)
          console.warn(
            `Skipping ${parsed.data.owed.length - recent.length} lost-reply line(s) owed for replies held more than 24 hours ago.`
          );
        fromBefore = recent;
      } else console.warn('Ignoring an unreadable record of held replies.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn(`Could not read the record of held replies: ${errorName(error)}`);
    }
    return new OwedLostLines(path, fromBefore);
  }

  /** Writes what is owed now, after any write already under way, whole or not at all. */
  save(owed: OwedLine[]): Promise<void> {
    const write = async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ owed }));
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await replaceFile(temporary, this.path);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    };
    this.writing = this.writing.then(write, write);
    return this.writing;
  }
}

/** How one more try went. */
export type ResendOutcome =
  | { kind: 'posted' }
  /** Switch still away: tried again later, inside the window. */
  | { kind: 'unavailable'; detail: string }
  /** Switch answered with a refusal, or the post can't go where it was meant to. */
  | { kind: 'final'; detail: string };

export class HeldReplies {
  private readonly held = new Map<string, Entry>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tries = new Map<string, number>();
  private readonly sending = new Set<string>();
  private stopped = false;

  constructor(
    private readonly deps: {
      now?: () => number;
      log?: Pick<Console, 'info' | 'warn'>;
      windowMs?: number;
      retryMs?: number[];
      lostWindowMs?: number;
      lostRetryMs?: number;
      /** Where what is owed is written down, so a restart still tells the room. */
      owed?: OwedLostLines;
    } = {}
  ) {}

  /** States what is owed now to the record, if there is one. */
  private record(): void {
    const owed = this.deps.owed;
    if (!owed || this.stopped) return;
    void owed
      .save(
        [...this.held.values()].map(({ key, sessionId, roomId, threadId, heldAt }) => ({
          key,
          sessionId,
          roomId,
          threadId,
          heldAt,
        }))
      )
      .catch((error: unknown) =>
        this.log.warn(`Could not record the held replies: ${errorName(error)}`)
      );
  }

  /**
   * Lines owed for posts the process before this one held and lost: each
   * room is told, once, as soon as Switch answers. `tellLost` makes the post
   * for one; null when its session is gone, which is logged.
   */
  owedFromBefore(
    owed: OwedLine[],
    tellLost: (line: OwedLine) => (() => Promise<ResendOutcome>) | null
  ): void {
    for (const line of owed) {
      if (this.stopped || this.held.has(line.key)) continue;
      const send = tellLost(line);
      if (!send) {
        this.log.warn(
          `Held reply ${line.key} of session ${line.sessionId} was lost in a restart, and its session is gone, so room ${line.roomId} is not told.`
        );
        continue;
      }
      this.log.warn(
        `Held reply ${line.key} of session ${line.sessionId} was lost in a restart; room ${line.roomId} is told once Switch answers.`
      );
      const unsent = async (): Promise<ResendOutcome> => ({
        kind: 'final',
        detail: 'lost in a restart',
      });
      this.held.set(line.key, {
        ...line,
        tool: 'post_message',
        args: {},
        resend: unsent,
        tellLost: send,
        unsendable: true,
        phase: 'lost',
        deadline: this.now + (this.deps.lostWindowMs ?? HELD_REPLY_LOST_WINDOW_MS),
      });
      this.tries.set(line.key, 0);
      this.schedule(line.key);
    }
    this.record();
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private get log(): Pick<Console, 'info' | 'warn'> {
    return this.deps.log ?? console;
  }

  get size(): number {
    return this.held.size;
  }

  /**
   * The post already held for this session with these same arguments: the
   * agent sending it again after being told not to. Answered as held again
   * rather than posted twice.
   */
  heldLike(sessionId: string, tool: string, args: Record<string, unknown>): HeldReply | null {
    const same = JSON.stringify(args);
    for (const entry of this.held.values())
      if (
        entry.phase === 'reply' &&
        entry.sessionId === sessionId &&
        entry.tool === tool &&
        JSON.stringify(entry.args) === same
      )
        return entry;
    return null;
  }

  /** Holds a post Switch could not take. False when no more can be held. */
  hold(entry: Omit<HeldReply, 'heldAt'>): boolean {
    // Lines owed for posts given up on hold no text and don't count.
    const holding = [...this.held.values()].filter((entry) => entry.phase === 'reply').length;
    if (this.stopped || holding >= HELD_REPLY_LIMIT) return false;
    const heldAt = this.now;
    const held: Entry = { ...entry, heldAt, phase: 'reply', deadline: heldAt + this.window };
    this.held.set(held.key, held);
    this.tries.set(held.key, 0);
    this.log.warn(
      `Holding reply ${held.key} of session ${held.sessionId} for room ${held.roomId}: Switch could not take it. It is sent again when Switch is back, for up to ${Math.round(this.window / 1000)} s.`
    );
    this.schedule(held.key);
    this.record();
    return true;
  }

  /** Switch is back (the agent's connection reopened): try every held post now. */
  retryNow(): void {
    for (const key of this.held.keys()) {
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
      void this.attempt(key);
    }
  }

  /**
   * This process is stopping: every post still held is lost, since no text is
   * kept anywhere else. Said once, with the posts it was. The record of what
   * is owed stays, so the next start tells each room.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.held.size)
      this.log.warn(
        `Stopping with ${this.held.size} reply(s) still held, which are lost (each room is told after the next start, once Switch answers): ${[
          ...this.held.values(),
        ]
          .map(
            (entry) =>
              `${entry.key} (session ${entry.sessionId}, room ${entry.roomId}${entry.phase === 'lost' ? ', already given up on, its room not yet told' : ''})`
          )
          .join(', ')}.`
      );
    this.held.clear();
  }

  /** Resolves once nothing is being sent. For tests. */
  async settled(): Promise<void> {
    while (this.sending.size) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  private get window(): number {
    return this.deps.windowMs ?? HELD_REPLY_WINDOW_MS;
  }

  private schedule(key: string): void {
    const held = this.held.get(key);
    if (!held || this.stopped) return;
    const waits =
      held.phase === 'lost'
        ? [this.deps.lostRetryMs ?? HELD_REPLY_LOST_RETRY_MS]
        : (this.deps.retryMs ?? HELD_REPLY_RETRY_MS);
    const tried = this.tries.get(key) ?? 0;
    const wait = waits[Math.min(tried, waits.length - 1)]!;
    const left = held.deadline - this.now;
    // The last try lands at the end of the window rather than past it.
    const timer = setTimeout(
      () => {
        this.timers.delete(key);
        void this.attempt(key);
      },
      Math.max(0, Math.min(wait, left))
    );
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private async attempt(key: string): Promise<void> {
    const held = this.held.get(key);
    if (!held || this.stopped || this.sending.has(key)) return;
    this.sending.add(key);
    const tried = (this.tries.get(key) ?? 0) + 1;
    this.tries.set(key, tried);
    let outcome: ResendOutcome;
    let sent: 'reply' | 'line' = 'reply';
    try {
      // Given up on, the reply is still sent once more under its own key
      // before the room is told it was lost: Switch may have made it on a try
      // whose answer was cut off, and then that copy is the answer, and no
      // "lost" line contradicts it.
      outcome = held.unsendable ? { kind: 'final', detail: 'not sent again' } : await held.resend();
      if (held.phase === 'lost' && outcome.kind === 'final') {
        if (!held.unsendable)
          this.log.warn(
            `Switch refused held reply ${key} of session ${held.sessionId} for room ${held.roomId} (${outcome.detail}); telling the room it was lost.`
          );
        held.unsendable = true;
        sent = 'line';
        outcome = await held.tellLost!();
      }
    } catch (error) {
      outcome = { kind: 'unavailable', detail: errorName(error) };
    } finally {
      this.sending.delete(key);
    }
    if (this.stopped || !this.held.has(key)) return;
    const heldFor = `${((this.now - held.heldAt) / 1000).toFixed(1)} s`;
    if (sent === 'line') {
      this.lineAttempt(key, held, outcome, heldFor);
      return;
    }
    if (outcome.kind === 'posted') {
      this.forget(key);
      this.log.info(
        `Posted held reply ${key} of session ${held.sessionId} to room ${held.roomId} on try ${tried}, ${heldFor} after it was held${held.phase === 'lost' ? ', after it was given up on' : ''}.`
      );
      return;
    }
    if (outcome.kind === 'final') {
      this.log.warn(
        `Gave up on held reply ${key} of session ${held.sessionId} for room ${held.roomId} after ${tried} try(s), ${heldFor}: ${outcome.detail}.${held.tellLost ? ' The room is told it was lost.' : ''}`
      );
      if (!held.tellLost) {
        this.forget(key);
        return;
      }
      // Switch has answered, so the room can be told now.
      this.toLost(key, held, true);
      return;
    }
    if (held.phase === 'reply' && this.now >= held.deadline) {
      this.log.warn(
        `Gave up on held reply ${key} of session ${held.sessionId} for room ${held.roomId}: Switch was still away after ${heldFor} and ${tried} try(s) (${outcome.detail}). It was not posted.${held.tellLost ? ' The room is told it was lost once Switch is back.' : ''}`
      );
      if (!held.tellLost) {
        this.forget(key);
        return;
      }
      this.toLost(key, held, false);
      return;
    }
    if (held.phase === 'lost' && this.now >= held.deadline) {
      this.forget(key);
      this.log.warn(
        `Could not tell room ${held.roomId} that held reply ${key} of session ${held.sessionId} was lost: Switch was still away (${outcome.detail}), ${heldFor} after it was held.`
      );
      return;
    }
    this.schedule(key);
  }

  /**
   * Kept only to settle what the room hears: tried each lost-line wait until
   * Switch is back. `now` when Switch has already answered, to tell it at once.
   */
  private toLost(key: string, held: Entry, now: boolean): void {
    held.phase = 'lost';
    if (now) held.unsendable = true;
    held.deadline = this.now + (this.deps.lostWindowMs ?? HELD_REPLY_LOST_WINDOW_MS);
    this.tries.set(key, 0);
    this.record();
    if (now) void this.attempt(key);
    else this.schedule(key);
  }

  /** How a try at the room's line for a lost post went. */
  private lineAttempt(key: string, held: Entry, outcome: ResendOutcome, heldFor: string): void {
    if (outcome.kind === 'posted') {
      this.forget(key);
      this.log.info(
        `Told room ${held.roomId} that held reply ${key} of session ${held.sessionId} was lost, ${heldFor} after it was held.`
      );
      return;
    }
    if (outcome.kind === 'final' || this.now >= held.deadline) {
      this.forget(key);
      this.log.warn(
        `Could not tell room ${held.roomId} that held reply ${key} of session ${held.sessionId} was lost (${outcome.detail}), ${heldFor} after it was held.`
      );
      return;
    }
    this.schedule(key);
  }

  private forget(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.tries.delete(key);
    this.held.delete(key);
    this.record();
  }
}
