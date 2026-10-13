import { differenceInCalendarDays, format, formatDistanceStrict } from 'date-fns';

/**
 * When something happened, the way the server page says it: a clock time for
 * today and yesterday, a weekday within the week, a date before that.
 */
export function sinceLabel(iso: string, now: Date): string {
  const at = new Date(iso);
  const days = differenceInCalendarDays(now, at);
  const time = format(at, 'HH:mm');
  if (days <= 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  if (days < 7) return `${format(at, 'EEEE')}, ${time}`;
  return `${format(at, 'd MMM')}, ${time}`;
}

/** For recent activity: "just now", "3 min ago", "today 09:14", "yesterday",
 * a weekday, then a date. */
export function activityWhen(iso: string, now: Date): string {
  const at = new Date(iso);
  const seconds = (now.getTime() - at.getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 60 * 60) return `${Math.floor(seconds / 60)} min ago`;
  const days = differenceInCalendarDays(now, at);
  if (days <= 0) return `today ${format(at, 'HH:mm')}`;
  if (days === 1) return 'yesterday';
  if (days < 7) return format(at, 'EEEE');
  return format(at, 'd MMM');
}

/** "2 days ago", for how long a server has been down. */
export function agoLabel(iso: string, now: Date): string {
  const at = new Date(iso);
  if (now.getTime() - at.getTime() < 60_000) return 'just now';
  return `${formatDistanceStrict(at, now)} ago`;
}
