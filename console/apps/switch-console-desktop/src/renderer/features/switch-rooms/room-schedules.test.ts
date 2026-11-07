import { describe, expect, it } from 'vitest';
import type { RoomSchedule } from '@shared/core/switch-servers/switch-servers';
import {
  absentAgentIds,
  blankDraft,
  describeTiming,
  draftFromSchedule,
  draftToInput,
  lastRunNote,
  scheduleStatus,
  timezoneChoices,
  wallClockIn,
} from './room-schedules';

const schedule = (overrides: Partial<RoomSchedule> = {}): RoomSchedule => ({
  id: 's1',
  roomId: 'room-1',
  agentIds: ['a1', 'a2'],
  message: 'Summarise new issues',
  type: 'cron',
  cronExpression: '0 9 * * 1',
  runAt: null,
  timezone: 'Europe/Berlin',
  enabled: true,
  nextRunAt: '2026-11-09T08:00:00+00:00',
  lastRunAt: null,
  lastOutcome: null,
  lastError: null,
  ...overrides,
});

describe('the schedule form', () => {
  it('starts as a daily repeat in the given timezone', () => {
    const draft = blankDraft(['a1'], 'Asia/Tokyo');
    expect(draft).toMatchObject({
      agentIds: ['a1'],
      type: 'cron',
      cronExpression: '0 9 * * *',
      timezone: 'Asia/Tokyo',
    });
  });

  it('asks for what is missing, one thing at a time', () => {
    const draft = blankDraft([], 'UTC');
    const error = (d = draft) => {
      const result = draftToInput(d);
      return result.ok ? null : result.error;
    };
    expect(error()).toMatch(/at least one agent/);
    expect(error({ ...draft, agentIds: ['a1'] })).toMatch(/message/);
    expect(error({ ...draft, agentIds: ['a1'], message: '  ' })).toMatch(/message/);
    expect(error({ ...draft, agentIds: ['a1'], message: 'hi', type: 'once' })).toMatch(
      /date and time/
    );
    expect(error({ ...draft, agentIds: ['a1'], message: 'hi', cronExpression: '* *' })).toMatch(
      /five fields/
    );
  });

  it('makes a repeating request with no one-off time', () => {
    const result = draftToInput({
      ...blankDraft(['a1'], 'UTC'),
      message: ' hello ',
      cronExpression: '0   9 * *  1-5',
    });
    expect(result).toEqual({
      ok: true,
      input: {
        agentIds: ['a1'],
        message: 'hello',
        type: 'cron',
        cronExpression: '0 9 * * 1-5',
        runAt: null,
        timezone: 'UTC',
      },
    });
  });

  it('makes a one-off request with no rule', () => {
    const result = draftToInput({
      ...blankDraft(['a1'], 'America/New_York'),
      message: 'hello',
      type: 'once',
      runAt: '2026-12-01T09:00',
    });
    expect(result).toMatchObject({
      ok: true,
      input: { type: 'once', cronExpression: null, runAt: '2026-12-01T09:00' },
    });
  });

  it('edits a one-off at the wall-clock time of its own timezone', () => {
    const draft = draftFromSchedule(
      schedule({
        type: 'once',
        cronExpression: null,
        runAt: '2026-12-01T14:00:00+00:00',
        timezone: 'America/New_York',
      })
    );
    expect(draft.runAt).toBe('2026-12-01T09:00');
    expect(draft.type).toBe('once');
  });

  it('edits a repeat with its rule', () => {
    expect(draftFromSchedule(schedule()).cronExpression).toBe('0 9 * * 1');
  });
});

describe('wall-clock time', () => {
  it('follows daylight saving', () => {
    expect(wallClockIn('2026-01-15T14:00:00Z', 'America/New_York')).toBe('2026-01-15T09:00');
    expect(wallClockIn('2026-07-15T13:00:00Z', 'America/New_York')).toBe('2026-07-15T09:00');
  });

  it('shows midnight as 00:00', () => {
    expect(wallClockIn('2026-01-15T05:00:00Z', 'America/New_York')).toBe('2026-01-15T00:00');
  });
});

describe('describing a timing', () => {
  it.each([
    ['* * * * *', 'Every minute'],
    ['15 * * * *', 'Every hour at :15'],
    ['0 9 * * *', 'Every day at 09:00'],
    ['30 17 * * 5', 'Every Friday at 17:30'],
    ['0 8 1 * *', 'On the 1st of every month at 08:00'],
    ['0 8 22 3 *', 'Every March 22nd at 08:00'],
  ])('%s reads %s', (cronExpression, words) => {
    expect(describeTiming(schedule({ cronExpression }))).toBe(words);
  });

  it('shows a rule the picker cannot draw as it was written', () => {
    expect(describeTiming(schedule({ cronExpression: '0 9 * * 1-5' }))).toBe(
      'Repeats on “0 9 * * 1-5”'
    );
  });

  it('gives a one-off in its own timezone', () => {
    expect(
      describeTiming(
        schedule({ type: 'once', runAt: '2026-12-01T08:00:00+00:00', timezone: 'Europe/Berlin' })
      )
    ).toBe('Once, Tue, 1 Dec 2026, 09:00');
  });
});

describe('what a schedule has come to', () => {
  it('names the agents it addresses that have left the room', () => {
    expect(absentAgentIds(schedule(), ['a2', 'a3'])).toEqual(['a1']);
    expect(absentAgentIds(schedule(), ['a1', 'a2'])).toEqual([]);
  });

  it('calls a finished one-off sent, not paused', () => {
    expect(scheduleStatus(schedule()).label).toBe('Active');
    expect(scheduleStatus(schedule({ enabled: false })).label).toBe('Paused');
    expect(
      scheduleStatus(
        schedule({
          type: 'once',
          enabled: false,
          lastRunAt: '2026-12-01T08:00:00+00:00',
          lastOutcome: 'posted',
        })
      )
    ).toEqual({ label: 'Sent', tone: 'done' });
  });

  it('says nothing about a firing that went well', () => {
    expect(lastRunNote(schedule())).toBeNull();
    expect(lastRunNote(schedule({ lastOutcome: 'posted' }))).toBeNull();
  });

  it('says why a firing did not go as planned', () => {
    expect(
      lastRunNote(schedule({ lastOutcome: 'skipped', lastError: 'The room is archived' }))
    ).toBe('Not sent: The room is archived');
    expect(lastRunNote(schedule({ lastOutcome: 'failed', lastError: 'transport down' }))).toBe(
      'Could not be sent: transport down'
    );
    expect(lastRunNote(schedule({ lastOutcome: 'partial', lastError: '1 agent left out' }))).toBe(
      '1 agent left out'
    );
  });
});

describe('timezone choices', () => {
  it('always include UTC and the current one, in order', () => {
    const zones = timezoneChoices('Etc/Custom-Zone');
    expect(zones).toContain('UTC');
    expect(zones).toContain('Europe/Berlin');
    expect(zones).toContain('Etc/Custom-Zone');
    expect(zones).toEqual([...zones].sort((a, b) => a.localeCompare(b)));
  });
});
