import { describe, expect, it } from 'vitest';
import { activityWhen, agoLabel, sinceLabel } from './server-times';

const NOW = new Date(2026, 9, 14, 15, 30); // a Wednesday

describe('server times', () => {
  it('says when a server started: today, yesterday, a weekday, then a date', () => {
    expect(sinceLabel(new Date(2026, 9, 14, 9, 14).toISOString(), NOW)).toBe('Today, 09:14');
    expect(sinceLabel(new Date(2026, 9, 13, 9, 14).toISOString(), NOW)).toBe('Yesterday, 09:14');
    expect(sinceLabel(new Date(2026, 9, 12, 10, 2).toISOString(), NOW)).toBe('Monday, 10:02');
    expect(sinceLabel(new Date(2026, 8, 1, 10, 2).toISOString(), NOW)).toBe('1 Sep, 10:02');
  });

  it('says when something happened, closest first', () => {
    expect(activityWhen(new Date(2026, 9, 14, 15, 29, 30).toISOString(), NOW)).toBe('just now');
    expect(activityWhen(new Date(2026, 9, 14, 15, 27).toISOString(), NOW)).toBe('3 min ago');
    expect(activityWhen(new Date(2026, 9, 14, 9, 14).toISOString(), NOW)).toBe('today 09:14');
    expect(activityWhen(new Date(2026, 9, 13, 9, 14).toISOString(), NOW)).toBe('yesterday');
    expect(activityWhen(new Date(2026, 9, 12, 9, 14).toISOString(), NOW)).toBe('Monday');
  });

  it('says how long ago', () => {
    expect(agoLabel(new Date(2026, 9, 12, 15, 30).toISOString(), NOW)).toBe('2 days ago');
  });
});
