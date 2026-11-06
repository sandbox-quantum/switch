import { describe, expect, it } from 'vitest';
import {
  defaultOneOffInput,
  describeRule,
  describeTiming,
  nextRunLabel,
  sameTiming,
  timingFromForm,
  toLocalDateTimeInput,
} from './room-schedule-labels';

const stamp = (iso: string) => `at ${iso}`;

describe('describeRule', () => {
  it('words the shapes the picker makes', () => {
    expect(describeRule('* * * * *')).toBe('Every minute');
    expect(describeRule('5 * * * *')).toBe('Every hour at :05');
    expect(describeRule('30 9 * * *')).toBe('Every day at 09:30');
    expect(describeRule('0 9 * * 1')).toBe('Every Monday at 09:00');
    expect(describeRule('0 18 1 * *')).toBe('On the 1st of every month at 18:00');
    expect(describeRule('0 8 3 2 *')).toBe('Every February 3rd at 08:00');
  });

  it('shows a rule it cannot read as written', () => {
    expect(describeRule('0 9 * * 1-5')).toBe('On the rule 0 9 * * 1-5');
  });
});

describe('describeTiming and nextRunLabel', () => {
  it('names the timezone a rule is read in', () => {
    expect(
      describeTiming({ cron: '0 9 * * 1', runAt: null, timezone: 'Europe/London' }, stamp)
    ).toBe('Every Monday at 09:00 (Europe/London)');
    expect(
      describeTiming({ cron: null, runAt: '2026-11-01T09:00:00Z', timezone: 'UTC' }, stamp)
    ).toBe('Once, at 2026-11-01T09:00:00Z');
  });

  it('says why a schedule will not fire', () => {
    expect(nextRunLabel({ paused: true, nextRunAt: '2026-11-01T09:00:00Z' }, stamp)).toBe('Paused');
    expect(nextRunLabel({ paused: false, nextRunAt: null }, stamp)).toBe('Done');
    expect(nextRunLabel({ paused: false, nextRunAt: '2026-11-01T09:00:00Z' }, stamp)).toBe(
      'Next: at 2026-11-01T09:00:00Z'
    );
  });
});

describe('timingFromForm', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const form = { repeat: false, cron: '0 9 * * *', localDateTime: '', timezone: 'UTC' };

  it('sends a rule as written', () => {
    expect(timingFromForm({ ...form, repeat: true }, now)).toEqual({
      timing: { runAt: null, cron: '0 9 * * *', timezone: 'UTC' },
    });
  });

  it('sends a one-off as an instant', () => {
    const local = toLocalDateTimeInput('2026-10-29T10:15:00Z');
    const result = timingFromForm({ ...form, localDateTime: local }, now);
    expect(result).toEqual({
      timing: { runAt: '2026-10-29T10:15:00.000Z', cron: null, timezone: 'UTC' },
    });
  });

  it('refuses a one-off that is missing or past', () => {
    expect(timingFromForm(form, now)).toEqual({ error: 'Choose when to send it.' });
    const past = toLocalDateTimeInput('2026-10-27T10:00:00Z');
    expect(timingFromForm({ ...form, localDateTime: past }, now)).toEqual({
      error: 'Choose a time in the future.',
    });
  });
});

describe('timingFromForm when the Repeat switch is flipped', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const later = toLocalDateTimeInput('2026-10-29T10:15:00Z');
  const stale = { cron: '0 9 * * 1', localDateTime: later, timezone: 'Europe/London' };

  it('sends only the rule when Repeat is on, ignoring a one-off typed earlier', () => {
    expect(timingFromForm({ ...stale, repeat: true }, now)).toEqual({
      timing: { runAt: null, cron: '0 9 * * 1', timezone: 'Europe/London' },
    });
  });

  it('sends only the one-off when Repeat is off, ignoring a rule chosen earlier', () => {
    const result = timingFromForm({ ...stale, repeat: false, timezone: 'UTC' }, now);
    expect(result).toEqual({
      timing: { runAt: '2026-10-29T10:15:00.000Z', cron: null, timezone: 'UTC' },
    });
  });

  it('says what is missing when the date is part-filled', () => {
    const form = { repeat: false, cron: '0 9 * * 1', localDateTime: '', timezone: 'UTC' };
    expect(timingFromForm(form, now)).toEqual({ error: 'Choose when to send it.' });
    expect(timingFromForm({ ...form, incomplete: true }, now)).toEqual({
      error: 'Fill in the date and the time, including AM or PM.',
    });
  });
});

describe('defaultOneOffInput', () => {
  it('starts a one-off two minutes ahead, in the future', () => {
    const now = new Date('2026-10-28T12:00:30Z');
    const value = defaultOneOffInput(now);
    expect(value).toBe(toLocalDateTimeInput('2026-10-28T12:02:30Z'));
    expect(new Date(value).getTime()).toBeGreaterThan(now.getTime());
  });
});

describe('sameTiming', () => {
  const once = { runAt: '2026-10-29T10:15:00Z', cron: null, timezone: 'UTC' };

  it('treats the same instant as the same one-off, whatever its spelling', () => {
    expect(sameTiming({ ...once, runAt: '2026-10-29T10:15:00.000Z' }, once)).toBe(true);
    expect(sameTiming({ ...once, runAt: '2026-10-29T15:45:00+05:30' }, once)).toBe(true);
  });

  it('notices a changed time, rule, timezone or kind', () => {
    expect(sameTiming({ ...once, runAt: '2026-10-29T10:16:00.000Z' }, once)).toBe(false);
    expect(sameTiming({ ...once, timezone: 'Europe/London' }, once)).toBe(false);
    expect(sameTiming({ runAt: null, cron: '0 9 * * 1', timezone: 'UTC' }, once)).toBe(false);
    const rule = { runAt: null, cron: '0 9 * * 1', timezone: 'UTC' };
    expect(sameTiming(rule, rule)).toBe(true);
    expect(sameTiming({ ...rule, cron: '0 10 * * 1' }, rule)).toBe(false);
    expect(sameTiming(once, rule)).toBe(false);
  });
});
