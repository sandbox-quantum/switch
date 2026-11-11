import {
  MONTH_LABELS,
  ordinal,
  parseCron,
  WEEKDAY_LABELS,
} from '@renderer/lib/CronPicker/cron-utils';
import type { RemoteRoomSchedule } from '@shared/core/switch-servers/switch-servers';

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * When a recurring rule runs, in words. A rule the picker can draw reads as a
 * sentence; one it cannot (a range or a step, set through the API) is shown as
 * written rather than guessed at.
 */
export function describeCron(cron: string): string {
  const state = parseCron(cron);
  if (!state) return `On the rule ${cron}`;
  const at = clock(state.hour, state.minute);
  switch (state.period) {
    case 'minute':
      return 'Every minute';
    case 'hour':
      return `Every hour at :${String(state.minute).padStart(2, '0')}`;
    case 'day':
      return `Every day at ${at}`;
    case 'week':
      return `Every ${WEEKDAY_LABELS[state.weekDay]} at ${at}`;
    case 'month':
      return `On the ${ordinal(state.monthDay)} of every month at ${at}`;
    case 'year':
      return `Every ${MONTH_LABELS[state.month - 1]} ${ordinal(state.monthDay)} at ${at}`;
  }
}

/** A schedule's timing as its row shows it: the rule or the moment, and its timezone. */
export function describeTiming(schedule: Pick<RemoteRoomSchedule, 'cron' | 'runAt' | 'timezone'>) {
  if (schedule.cron !== null) return `${describeCron(schedule.cron)} (${schedule.timezone})`;
  return 'Once';
}

/** Where a schedule has got to: paused, sent for good, or waiting for its next run. */
export function scheduleState(
  schedule: Pick<RemoteRoomSchedule, 'paused' | 'nextRunAt'>
): 'paused' | 'sent' | 'waiting' {
  if (schedule.paused) return 'paused';
  return schedule.nextRunAt === null ? 'sent' : 'waiting';
}

function wallClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
  };
}

/** How far `timeZone`'s clock is ahead of UTC at `at`, in milliseconds. */
function offsetAt(at: number, timeZone: string): number {
  const c = wallClock(new Date(at), timeZone);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Whether `timeZone` is a zone this computer knows, such as `Asia/Tokyo`. */
export function knownTimezone(timeZone: string): boolean {
  if (timeZone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The moment a `datetime-local` value (`YYYY-MM-DDTHH:mm`) names on the clocks
 * of `timeZone`, not of this computer: a one-off set for 09:00 Asia/Tokyo goes
 * at nine in Tokyo wherever it was entered. The offset is read a second time at
 * the first answer, so a time just across a clock change lands on the right side.
 */
export function momentIn(wallTime: string, timeZone: string): string {
  const [date = '', time = ''] = wallTime.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const first = asUtc - offsetAt(asUtc, timeZone);
  return new Date(asUtc - offsetAt(first, timeZone)).toISOString();
}

/** The `datetime-local` value showing `iso` on the clocks of `timeZone`. */
export function wallTimeIn(iso: string, timeZone: string): string {
  const c = wallClock(new Date(iso), timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${c.year}-${pad(c.month)}-${pad(c.day)}T${pad(c.hour)}:${pad(c.minute)}`;
}
