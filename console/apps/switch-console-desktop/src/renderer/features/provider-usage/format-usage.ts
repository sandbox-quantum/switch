import { clampUsagePercent } from '@switch-console/agent-providers/subscription-usage';
import type { InterfaceSettings } from '@shared/core/app-settings';

export type PercentageDisplay = InterfaceSettings['usagePercentageDisplay'];

export function formatPercentage(
  used: number,
  display: PercentageDisplay,
  compact = false
): string {
  const percent = Math.round(clampUsagePercent(used));
  return display === 'used' ? `${percent}%${compact ? '' : ' used'}` : `${100 - percent}% left`;
}

export function usageTone(used: number): 'normal' | 'warning' | 'error' {
  if (used >= 90) return 'error';
  if (used >= 75) return 'warning';
  return 'normal';
}

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
export const formatUsageNumber = (value: number) => numberFormat.format(value);

const resetClock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function formatUpdatedAt(updatedAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return relativeTime.format(-minutes, 'minute');
  if (minutes < 1_440) return relativeTime.format(-Math.floor(minutes / 60), 'hour');
  return relativeTime.format(-Math.floor(minutes / 1_440), 'day');
}

export function formatReset(resetsAt: number, now: number): string {
  if (resetsAt <= now) return 'Reset due';
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const remainder = minutes % 60;
  const duration = days
    ? `${days}d ${hours}h`
    : hours
      ? `${hours}h ${remainder}m`
      : `${remainder}m`;
  return `Resets in ${duration} · ${resetClock.format(resetsAt)}`;
}

export const COMPACT_CHIP_WIDTH = 156;
export const WIDE_CHIP_WIDTH = 248;
export const ROSTER_CHIP_WIDTH = 60;
const CHIP_GAP = 4;

export function layoutUsageChips(width: number, count: number, needsRoster: boolean) {
  const available = Math.max(0, width);
  const spaceForRoster = ROSTER_CHIP_WIDTH + CHIP_GAP;
  const fit = (size: number, reserved = 0) =>
    Math.max(0, Math.floor((available - reserved + CHIP_GAP) / (size + CHIP_GAP)));
  const wide = fit(WIDE_CHIP_WIDTH, needsRoster ? spaceForRoster : 0) >= count;
  const chipWidth = wide ? WIDE_CHIP_WIDTH : COMPACT_CHIP_WIDTH;
  const showRoster = needsRoster || fit(chipWidth) < count;
  const visibleCount = Math.min(count, fit(chipWidth, showRoster ? spaceForRoster : 0));
  return { visibleCount, wide, showRoster };
}
