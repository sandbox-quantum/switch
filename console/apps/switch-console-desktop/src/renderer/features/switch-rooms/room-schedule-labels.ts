import {
  MONTH_LABELS,
  ordinal,
  parseCron,
  WEEKDAY_LABELS,
} from '@renderer/lib/CronPicker/cron-utils';
import type {
  RemoteRoomSchedule,
  RoomScheduleTiming,
} from '@shared/core/switch-servers/switch-servers';

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * A cron rule in words, for the shapes the picker makes: "Every Monday at 09:00".
 *
 * A rule it cannot read (a range, a list, a step) is shown as written rather
 * than guessed at, since the server fires on the rule and not on this summary.
 */
export function describeRule(cron: string): string {
  const state = parseCron(cron);
  if (state === null) return `On the rule ${cron}`;
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

/** When a schedule fires, in words, with the timezone a rule is read in. */
export function describeTiming(
  schedule: Pick<RemoteRoomSchedule, 'runAt' | 'cron' | 'timezone'>,
  formatTime: (iso: string) => string
): string {
  if (schedule.cron !== null) return `${describeRule(schedule.cron)} (${schedule.timezone})`;
  return schedule.runAt === null ? 'Not scheduled' : `Once, ${formatTime(schedule.runAt)}`;
}

/** Where a schedule stands: when it fires next, or why it will not. */
export function nextRunLabel(
  schedule: Pick<RemoteRoomSchedule, 'paused' | 'nextRunAt'>,
  formatTime: (iso: string) => string
): string {
  if (schedule.paused) return 'Paused';
  if (schedule.nextRunAt === null) return 'Done';
  return `Next: ${formatTime(schedule.nextRunAt)}`;
}

/**
 * The timing a form describes, or why it describes none.
 *
 * A one-off is typed as wall time on this computer (a `datetime-local` value)
 * and sent as an instant, so it fires when the clock here says so; a rule is
 * sent as written, with the timezone it is to be read in.
 */
export function timingFromForm(
  form: { repeat: boolean; cron: string; localDateTime: string; timezone: string },
  now: Date
): { timing: RoomScheduleTiming } | { error: string } {
  if (form.repeat) {
    return { timing: { runAt: null, cron: form.cron, timezone: form.timezone } };
  }
  if (form.localDateTime === '') return { error: 'Choose when to send it.' };
  const at = new Date(form.localDateTime);
  if (Number.isNaN(at.getTime())) return { error: 'That date and time could not be read.' };
  if (at <= now) return { error: 'Choose a time in the future.' };
  return { timing: { runAt: at.toISOString(), cron: null, timezone: form.timezone } };
}

/** An ISO instant as a `datetime-local` value on this computer's clock. */
export function toLocalDateTimeInput(iso: string): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}
