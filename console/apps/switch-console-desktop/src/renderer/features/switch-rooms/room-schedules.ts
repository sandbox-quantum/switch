import {
  DEFAULT_CRON_STATE,
  MONTH_LABELS,
  ordinal,
  parseCron,
  toCron,
  WEEKDAY_LABELS,
} from '@renderer/lib/CronPicker/cron-utils';
import type {
  RoomSchedule,
  RoomScheduleInput,
  RoomScheduleType,
} from '@shared/core/switch-servers/switch-servers';

/*
 * What the schedules tab works out from a room's schedules, apart from
 * drawing them: the form's draft and the request it makes, and how a timing
 * and a firing's outcome are put in words. Times a person types are read by
 * the server in the schedule's own timezone, so nothing here converts one.
 */

/** A schedule as the form holds it while it is being written. */
export type ScheduleDraft = {
  agentIds: string[];
  message: string;
  type: RoomScheduleType;
  cronExpression: string;
  /** `YYYY-MM-DDTHH:mm`, the value of a date-time input; wall-clock time in `timezone`. */
  runAt: string;
  timezone: string;
};

export function blankDraft(agentIds: string[], timezone: string): ScheduleDraft {
  return {
    agentIds,
    message: '',
    type: 'cron',
    cronExpression: toCron(DEFAULT_CRON_STATE),
    runAt: '',
    timezone,
  };
}

export function draftFromSchedule(schedule: RoomSchedule): ScheduleDraft {
  return {
    agentIds: schedule.agentIds,
    message: schedule.message,
    type: schedule.type,
    cronExpression: schedule.cronExpression ?? toCron(DEFAULT_CRON_STATE),
    runAt: schedule.runAt ? wallClockIn(schedule.runAt, schedule.timezone) : '',
    timezone: schedule.timezone,
  };
}

/** The request a draft makes, or what is missing from it. */
export function draftToInput(
  draft: ScheduleDraft
): { ok: true; input: RoomScheduleInput } | { ok: false; error: string } {
  if (draft.agentIds.length === 0) return { ok: false, error: 'Choose at least one agent.' };
  const message = draft.message.trim();
  if (message === '') return { ok: false, error: 'Write the message to send.' };
  if (draft.timezone === '') return { ok: false, error: 'Choose a timezone.' };
  const base = { agentIds: draft.agentIds, message, timezone: draft.timezone };
  if (draft.type === 'once') {
    if (draft.runAt === '') return { ok: false, error: 'Pick the date and time to send it.' };
    return { ok: true, input: { ...base, type: 'once', cronExpression: null, runAt: draft.runAt } };
  }
  const expression = draft.cronExpression.trim().replace(/\s+/g, ' ');
  if (expression.split(' ').length !== 5) {
    return {
      ok: false,
      error: 'A repeat rule has five fields: minute, hour, day of month, month, day of week.',
    };
  }
  return { ok: true, input: { ...base, type: 'cron', cronExpression: expression, runAt: null } };
}

/** `YYYY-MM-DDTHH:mm` for a moment, as the clocks in `timezone` show it. */
export function wallClockIn(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((each) => each.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

/** A moment in words, in the schedule's timezone: `Mon, 9 Nov 2026, 09:00`. */
export function formatRun(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

const twoDigits = (n: number) => String(n).padStart(2, '0');

/** When a schedule fires, in words; a rule the picker cannot draw is shown as written. */
export function describeTiming(
  schedule: Pick<RoomSchedule, 'type' | 'cronExpression' | 'runAt' | 'timezone'>
): string {
  if (schedule.type === 'once') {
    return schedule.runAt ? `Once, ${formatRun(schedule.runAt, schedule.timezone)}` : 'Once';
  }
  const expression = schedule.cronExpression ?? '';
  const state = parseCron(expression);
  if (state === null) return `Repeats on “${expression}”`;
  const time = `${twoDigits(state.hour)}:${twoDigits(state.minute)}`;
  switch (state.period) {
    case 'minute':
      return 'Every minute';
    case 'hour':
      return `Every hour at :${twoDigits(state.minute)}`;
    case 'day':
      return `Every day at ${time}`;
    case 'week':
      return `Every ${WEEKDAY_LABELS[state.weekDay]} at ${time}`;
    case 'month':
      return `On the ${ordinal(state.monthDay)} of every month at ${time}`;
    case 'year':
      return `Every ${MONTH_LABELS[state.month - 1]} ${ordinal(state.monthDay)} at ${time}`;
  }
}

/** The addressed agents that are no longer in the room. */
export function absentAgentIds(schedule: RoomSchedule, roomAgentIds: string[]): string[] {
  return schedule.agentIds.filter((id) => !roomAgentIds.includes(id));
}

/** Where a schedule stands, for its row: its state first, then how it last went. */
export function scheduleStatus(schedule: RoomSchedule): {
  label: string;
  tone: 'active' | 'paused' | 'done';
} {
  if (schedule.enabled) return { label: 'Active', tone: 'active' };
  if (
    schedule.type === 'once' &&
    schedule.lastRunAt !== null &&
    schedule.lastOutcome === 'posted'
  ) {
    return { label: 'Sent', tone: 'done' };
  }
  return { label: 'Paused', tone: 'paused' };
}

/** What to tell about the latest firing when it was not a plain success, else null. */
export function lastRunNote(schedule: RoomSchedule): string | null {
  switch (schedule.lastOutcome) {
    case null:
    case 'posted':
      return null;
    case 'partial':
      return schedule.lastError ?? 'Sent, but without some of its agents.';
    case 'skipped':
      return `Not sent: ${schedule.lastError ?? 'nothing to send it to'}`;
    case 'missed':
      return `Not sent: ${schedule.lastError ?? 'it was too late to run'}`;
    case 'failed':
      return `Could not be sent: ${schedule.lastError ?? 'the post failed'}`;
  }
}

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The timezones to choose from, with `current` and UTC always among them. */
export function timezoneChoices(current: string): string[] {
  const zones = new Set<string>(['UTC', ...Intl.supportedValuesOf('timeZone')]);
  zones.add(current);
  return [...zones].sort((a, b) => a.localeCompare(b));
}
