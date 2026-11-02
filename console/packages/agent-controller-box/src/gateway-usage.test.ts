import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DailyCallCap,
  dailyCalls,
  SAVE_EVERY_MS,
  type UsageFile,
  usageFile,
} from './gateway-usage';
import type { Logger } from './log';

/** 2026-10-28T12:00:00Z */
const NOON = Date.UTC(2026, 9, 28, 12, 0, 0);
const MIDNIGHT = Date.UTC(2026, 9, 29, 0, 0, 0);

function recordingLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const keep = (message: string, fields?: Record<string, unknown>) =>
    lines.push(`${message} ${JSON.stringify(fields ?? {})}`);
  return { lines, debug: keep, info: keep, warn: keep, error: keep };
}

function memoryFile(
  initial: string | null = null
): UsageFile & { text: string | null; writes: number } {
  const file = {
    text: initial,
    writes: 0,
    read: () => file.text,
    write: (text: string) => {
      file.text = text;
      file.writes += 1;
    },
  };
  return file;
}

function saved(day: string, calls: number): string {
  return JSON.stringify({ v: 1, day, calls });
}

describe('the setting', () => {
  it('is a whole number of calls a day; unset, empty or 0 means no cap', () => {
    expect(dailyCalls(undefined)).toBe(0);
    expect(dailyCalls('')).toBe(0);
    expect(dailyCalls('0')).toBe(0);
    expect(dailyCalls(' 500 ')).toBe(500);
  });

  it('refuses anything else, so a typo never quietly means no cap', () => {
    for (const bad of ['abc', '-1', '1e3', '5.5', '2000000000', '10 calls'])
      expect(() => dailyCalls(bad), bad).toThrow('SWITCH_CONTROLLER_GATEWAY_DAILY_CALLS');
  });
});

describe('the daily cap', () => {
  it('lets the day’s calls through, then refuses until 00:00 UTC, without counting refusals', () => {
    const log = recordingLog();
    const cap = new DailyCallCap({ cap: 3, file: memoryFile(), log, now: () => NOON });
    expect([cap.take(), cap.take(), cap.take()]).toEqual([null, null, null]);
    expect(cap.take()).toBe((MIDNIGHT - NOON) / 1000);
    expect(cap.take()).toBe((MIDNIGHT - NOON) / 1000);
    expect(cap.counts()).toEqual({ callsToday: 3, capped: true });
  });

  it('says so once a day, with numbers only', () => {
    let clock = NOON;
    const log = recordingLog();
    const cap = new DailyCallCap({ cap: 1, file: memoryFile(), log, now: () => clock });
    cap.take();
    cap.take();
    cap.take();
    const said = log.lines.filter((l) =>
      l.startsWith('The provider gateway reached its daily call cap')
    );
    expect(said).toEqual([
      'The provider gateway reached its daily call cap {"calls":1,"cap":1,"day":"2026-10-28"}',
    ]);
    clock = MIDNIGHT + 1000;
    cap.take();
    cap.take();
    expect(log.lines.filter((l) => l.includes('reached its daily call cap'))).toHaveLength(2);
  });

  it('starts again at 00:00 UTC', () => {
    let clock = MIDNIGHT - 1;
    const cap = new DailyCallCap({
      cap: 1,
      file: memoryFile(),
      log: recordingLog(),
      now: () => clock,
    });
    expect(cap.take()).toBeNull();
    expect(cap.take()).toBe(1);
    clock = MIDNIGHT;
    expect(cap.counts()).toEqual({ callsToday: 0, capped: false });
    expect(cap.take()).toBeNull();
  });
});

describe('the saved count', () => {
  it('is saved at most once a minute while calls come in, and when the controller stops', () => {
    let clock = NOON;
    const file = memoryFile();
    const cap = new DailyCallCap({ cap: 100, file, log: recordingLog(), now: () => clock });
    cap.take();
    expect(file.writes).toBe(1);
    expect(file.text).toBe(saved('2026-10-28', 1));
    clock += SAVE_EVERY_MS - 1;
    cap.take();
    cap.take();
    expect(file.writes).toBe(1);
    clock += 1;
    cap.take();
    expect(file.writes).toBe(2);
    expect(file.text).toBe(saved('2026-10-28', 4));
    cap.take();
    cap.save();
    expect(file.text).toBe(saved('2026-10-28', 5));
    cap.save();
    expect(file.writes).toBe(3);
  });

  it('survives a restart the same day, so the day’s calls stay used', () => {
    const file = memoryFile(saved('2026-10-28', 2));
    const cap = new DailyCallCap({ cap: 3, file, log: recordingLog(), now: () => NOON });
    expect(cap.counts()).toEqual({ callsToday: 2, capped: false });
    expect(cap.take()).toBeNull();
    expect(cap.take()).not.toBeNull();
  });

  it('a count from an earlier day, or no file, starts the day at zero without a warning', () => {
    for (const text of [saved('2026-10-27', 99), null]) {
      const log = recordingLog();
      const cap = new DailyCallCap({ cap: 3, file: memoryFile(text), log, now: () => NOON });
      expect(cap.counts().callsToday).toBe(0);
      expect(log.lines).toEqual([]);
    }
  });

  it('a corrupt file counts from zero with a warning, and is put right at the next save', () => {
    for (const [text, reason] of [
      ['{', 'not_json'],
      [JSON.stringify({ v: 2, day: '2026-10-28', calls: 1 }), 'bad_shape'],
      [saved('2026-10-28', -5), 'bad_shape'],
      [saved('2026-10-28', 1.5), 'bad_shape'],
      [JSON.stringify({ v: 1, day: 'today', calls: 1 }), 'bad_shape'],
      [saved('2026-10-29', 0), 'future_day'],
    ] as const) {
      const log = recordingLog();
      const file = memoryFile(text);
      const cap = new DailyCallCap({ cap: 3, file, log, now: () => NOON });
      expect(cap.counts().callsToday, text).toBe(0);
      expect(log.lines, text).toEqual([
        `The provider gateway’s daily call count was unreadable: counting from zero {"reason":"${reason}"}`,
      ]);
      cap.save();
      expect(file.text).toBe(saved('2026-10-28', 0));
    }
  });

  it('a file it can’t read or write never stops the counting', () => {
    const log = recordingLog();
    const failing: UsageFile = {
      read: () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
      write: () => {
        throw Object.assign(new Error('full'), { code: 'ENOSPC' });
      },
    };
    const cap = new DailyCallCap({ cap: 2, file: failing, log, now: () => NOON });
    expect(cap.take()).toBeNull();
    expect(cap.take()).toBeNull();
    expect(cap.take()).not.toBeNull();
    expect(log.lines.join('\n')).toContain('"reason":"EACCES"');
    expect(log.lines.join('\n')).toContain('"error":"ENOSPC"');
  });
});

describe('the usage file on disk', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is written whole, readable only by the controller, and read back', () => {
    dir = mkdtempSync(join(tmpdir(), 'gateway-usage-'));
    const path = join(dir, 'gateway-usage.json');
    const file = usageFile(path);
    expect(file.read()).toBeNull();
    file.write(saved('2026-10-28', 7));
    expect(file.read()).toBe(saved('2026-10-28', 7));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const cap = new DailyCallCap({ cap: 10, file, log: recordingLog(), now: () => NOON });
    expect(cap.counts().callsToday).toBe(7);
  });
});
