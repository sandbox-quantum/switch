import { expect, it } from 'vitest';
import {
  formatPercentage,
  formatReset,
  layoutUsageChips,
  usageTone,
} from '@renderer/features/provider-usage/format-usage';

it('clamps percentages and keeps the severity tied to usage', () => {
  expect(formatPercentage(119, 'used')).toBe('100% used');
  expect(formatPercentage(-3, 'remaining')).toBe('100% left');
  expect(formatPercentage(6.8, 'used', true)).toBe('7%');
  expect(formatPercentage(6.8, 'remaining', true)).toBe('93% left');
  expect([74, 75, 89, 90].map(usageTone)).toEqual(['normal', 'warning', 'warning', 'error']);
});

it('formats reset countdowns by the minute and handles a reset that is due', () => {
  const now = Date.parse('2030-02-01T10:30:00Z');
  expect(formatReset(now + 135 * 60_000, now)).toMatch(/^Resets in 2h 15m · /);
  expect(formatReset(now + 10_000, now)).toMatch(/^Resets in 1m · /);
  expect(formatReset(now, now)).toBe('Reset due');
});

it('keeps a roster trigger visible as chips overflow at narrow widths', () => {
  expect(layoutUsageChips(500, 2, false)).toEqual({
    visibleCount: 2,
    wide: true,
    showRoster: false,
  });
  expect(layoutUsageChips(320, 2, false)).toEqual({
    visibleCount: 2,
    wide: false,
    showRoster: false,
  });
  expect(layoutUsageChips(224, 2, false)).toEqual({
    visibleCount: 1,
    wide: false,
    showRoster: true,
  });
  expect(layoutUsageChips(90, 2, false)).toEqual({
    visibleCount: 0,
    wide: false,
    showRoster: true,
  });
  expect(layoutUsageChips(500, 0, true)).toMatchObject({ visibleCount: 0, showRoster: true });
});
