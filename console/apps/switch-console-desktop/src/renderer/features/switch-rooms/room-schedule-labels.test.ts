import { describe, expect, it } from 'vitest';
import {
  describeCron,
  describeTiming,
  knownTimezone,
  momentIn,
  scheduleState,
  wallTimeIn,
} from './room-schedule-labels';

describe('describeCron', () => {
  it.each([
    ['* * * * *', 'Every minute'],
    ['5 * * * *', 'Every hour at :05'],
    ['30 9 * * *', 'Every day at 09:30'],
    ['0 9 * * 1', 'Every Monday at 09:00'],
    ['0 18 15 * *', 'On the 15th of every month at 18:00'],
    ['0 8 1 4 *', 'Every April 1st at 08:00'],
  ])('reads %s as a sentence', (cron, sentence) => {
    expect(describeCron(cron)).toBe(sentence);
  });

  it('shows a rule the picker cannot draw as written, rather than guessing', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('On the rule 0 9 * * 1-5');
  });
});

describe('describeTiming', () => {
  it('names the timezone a recurring rule is read in', () => {
    expect(describeTiming({ cron: '0 9 * * 1', runAt: null, timezone: 'Europe/London' })).toBe(
      'Every Monday at 09:00 (Europe/London)'
    );
  });

  it('calls a one-off what it is; its moment is shown beside it', () => {
    expect(
      describeTiming({ cron: null, runAt: '2026-12-01T09:00:00Z', timezone: 'Europe/London' })
    ).toBe('Once');
  });
});

describe('scheduleState', () => {
  it('says paused before anything else', () => {
    expect(scheduleState({ paused: true, nextRunAt: '2026-12-01T09:00:00Z' })).toBe('paused');
  });

  it('says sent for a one-off with no run left', () => {
    expect(scheduleState({ paused: false, nextRunAt: null })).toBe('sent');
  });

  it('says waiting while a run is still to come', () => {
    expect(scheduleState({ paused: false, nextRunAt: '2026-12-01T09:00:00Z' })).toBe('waiting');
  });
});

describe('a one-off time is read on the clocks of its own timezone', () => {
  it.each([
    ['2026-11-20T09:00', 'Asia/Tokyo', '2026-11-20T00:00:00.000Z'],
    ['2026-11-20T09:00', 'Europe/London', '2026-11-20T09:00:00.000Z'],
    ['2026-07-20T09:00', 'Europe/London', '2026-07-20T08:00:00.000Z'],
    ['2026-11-20T09:00', 'America/New_York', '2026-11-20T14:00:00.000Z'],
  ])('%s in %s is %s, wherever it was entered', (wall, zone, iso) => {
    expect(momentIn(wall, zone)).toBe(iso);
    expect(wallTimeIn(iso, zone)).toBe(wall);
  });

  it('lands a time just after the clocks go forward on the right side', () => {
    // London goes to summer time at 01:00 UTC on 29 March 2026.
    expect(momentIn('2026-03-29T03:00', 'Europe/London')).toBe('2026-03-29T02:00:00.000Z');
    expect(momentIn('2026-03-29T00:30', 'Europe/London')).toBe('2026-03-29T00:30:00.000Z');
  });

  it('knows a real zone from a typo', () => {
    expect(knownTimezone('Asia/Tokyo')).toBe(true);
    expect(knownTimezone('Mars/Olympus')).toBe(false);
    expect(knownTimezone('')).toBe(false);
  });
});
