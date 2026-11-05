import { describe, expect, it } from 'vitest';
import { scheduleTime } from './schedule-time';

describe('schedule time display', () => {
  const value = '2026-11-06T09:00:00Z';

  it('shows the time in a supported schedule timezone', () => {
    expect(scheduleTime(value, 'Asia/Kolkata')).toBe(
      `${new Date(value).toLocaleString(undefined, { timeZone: 'Asia/Kolkata' })} (Asia/Kolkata)`
    );
  });

  it('keeps a server timezone readable when Intl does not support it', () => {
    expect(scheduleTime(value, 'Factory')).toBe(
      `${new Date(value).toLocaleString(undefined, { timeZone: 'UTC' })} (UTC; scheduled in Factory)`
    );
  });
});
