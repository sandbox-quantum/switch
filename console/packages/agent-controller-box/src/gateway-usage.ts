import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Logger } from './log';

/**
 * The box's daily cap on provider calls through the gateway: a
 * safety net against a runaway agent or a misused token, set by the operator.
 * A box serves one user, so the box's count is that user's count.
 *
 * Calls are counted in a UTC day, across every agent and probe. The count is
 * saved to the controller's own data folder (the day and the count, nothing
 * else), at most once a minute and when the controller stops, so a restart
 * doesn't reset the day.
 */

/** The setting: a whole number of calls a day; unset, empty or 0 means no cap. */
export const DAILY_CALLS_SETTING = 'SWITCH_CONTROLLER_GATEWAY_DAILY_CALLS';
/** The count is saved at most this often while calls come in. */
export const SAVE_EVERY_MS = 60_000;
const MAX_CAP = 1_000_000_000;

/** Reads the setting; throws on anything but a whole number, so a typo never means "no cap". */
export function dailyCalls(setting: string | undefined): number {
  const raw = (setting ?? '').trim();
  if (raw === '') return 0;
  if (!/^[0-9]{1,10}$/.test(raw) || Number(raw) > MAX_CAP)
    throw new Error(`${DAILY_CALLS_SETTING} must be a whole number of calls a day (0 for no cap).`);
  return Number(raw);
}

export type UsageFile = {
  read: () => string | null;
  write: (text: string) => void;
};

/** The usage file in the controller's data folder: written whole, then renamed into place. */
export function usageFile(path: string): UsageFile {
  return {
    read: () => {
      try {
        return readFileSync(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    write: (text) => {
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, text, { mode: 0o600 });
      renameSync(temporary, path);
    },
  };
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function secondsToNextUtcDay(ms: number): number {
  const next = new Date(ms);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - ms) / 1000));
}

export class DailyCallCap {
  private day: string;
  private calls = 0;
  private dirty = false;
  private savedAt = Number.NEGATIVE_INFINITY;
  /** The day the cap was last said to be hit, so it's said once a day. */
  private saidCapped: string | null = null;

  constructor(
    private readonly deps: {
      cap: number;
      file: UsageFile;
      log: Logger;
      now?: () => number;
    }
  ) {
    this.day = utcDay(this.now());
    this.load();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Counts one call, or refuses it: null when it may go, or the seconds until
   * the cap resets when the day's calls are used up. A refused call isn't counted.
   */
  take(): number | null {
    const now = this.now();
    this.rollOver(now);
    if (this.calls >= this.deps.cap) {
      if (this.saidCapped !== this.day) {
        this.saidCapped = this.day;
        this.deps.log.warn('The provider gateway reached its daily call cap', {
          calls: this.calls,
          cap: this.deps.cap,
          day: this.day,
        });
      }
      return secondsToNextUtcDay(now);
    }
    this.calls += 1;
    this.dirty = true;
    if (now - this.savedAt >= SAVE_EVERY_MS) this.save();
    return null;
  }

  /** For the machine report. */
  counts(): { callsToday: number; capped: boolean } {
    this.rollOver(this.now());
    return { callsToday: this.calls, capped: this.calls >= this.deps.cap };
  }

  /** Saves the count if it changed; the controller calls this when it stops. */
  save(): void {
    if (!this.dirty) return;
    try {
      this.deps.file.write(JSON.stringify({ v: 1, day: this.day, calls: this.calls }));
      this.dirty = false;
      this.savedAt = this.now();
    } catch (error) {
      // Counting goes on in memory; the next save tries again.
      this.deps.log.warn('Could not save the provider gateway’s daily call count', {
        error: (error as NodeJS.ErrnoException).code ?? 'unknown',
      });
    }
  }

  private rollOver(now: number): void {
    const today = utcDay(now);
    if (today === this.day) return;
    this.day = today;
    this.calls = 0;
    this.dirty = true;
  }

  private load(): void {
    let text: string | null;
    try {
      text = this.deps.file.read();
    } catch (error) {
      this.corrupt((error as NodeJS.ErrnoException).code ?? 'unreadable');
      return;
    }
    if (text === null) return;
    let saved: unknown;
    try {
      saved = JSON.parse(text);
    } catch {
      this.corrupt('not_json');
      return;
    }
    const { v, day, calls } = (saved ?? {}) as Record<string, unknown>;
    if (
      v !== 1 ||
      typeof day !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      typeof calls !== 'number' ||
      !Number.isSafeInteger(calls) ||
      calls < 0
    ) {
      this.corrupt('bad_shape');
      return;
    }
    // A day still to come can't have been saved honestly.
    if (day > this.day) {
      this.corrupt('future_day');
      return;
    }
    if (day === this.day) this.calls = calls;
  }

  private corrupt(reason: string): void {
    this.deps.log.warn(
      'The provider gateway’s daily call count was unreadable: counting from zero',
      {
        reason,
      }
    );
    this.dirty = true;
  }
}
