import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addActivity,
  runActivity,
  activityLog,
  updateActivity,
  waitActivity,
  type Activity,
} from './activity-log';
import { lines, plainText, rich } from './rich-text';

/** An activity log, and the last whole list it gave. */
function recorded() {
  let last: readonly Activity[] = [];
  const log = activityLog((activities) => (last = activities));
  return { log, activities: () => last };
}

describe('activityLog', () => {
  it('gives the whole list anew after every change, leaving the one before as it was', () => {
    const seen: (readonly Activity[])[] = [];
    const log = activityLog((activities) => seen.push(activities));

    const a = addActivity(log, { title: 'a', status: 'working', outcome: null, description: null });
    addActivity(log, { title: 'b', status: 'waiting', outcome: null, description: null });
    updateActivity(log, a, { status: 'done' });

    expect(seen.map((activities) => activities.map((s) => `${s.title}:${s.status}`))).toEqual([
      ['a:working'],
      ['a:working', 'b:waiting'],
      ['a:done', 'b:waiting'],
    ]);
  });
});

describe('runActivity', () => {
  it('marks the activity done and keeps the outcome fn set', async () => {
    const { log, activities } = recorded();
    const result = await runActivity(log, 'look', null, (update) => {
      update({ outcome: rich`found`, description: rich`At /bin/x` });
      return 42;
    });

    expect(result).toBe(42);
    expect(activities()).toEqual([
      {
        id: expect.any(String),
        title: 'look',
        status: 'done',
        outcome: rich`found`,
        description: rich`At /bin/x`,
      },
    ]);
  });

  it('marks the activity failed, adds the error message to its description and rethrows', async () => {
    const { log, activities } = recorded();
    await expect(
      runActivity(log, 'run', rich`Runs x`, () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(activities()[0]).toMatchObject({
      status: 'failed',
      outcome: rich`failed`,
      description: lines(rich`Runs x`, rich`boom`),
    });
  });

  it('leaves an activity fn marked failed as failed', async () => {
    const { log, activities } = recorded();
    await runActivity(log, 'run', null, (update) =>
      update({ status: 'failed', outcome: rich`exit 1` })
    );

    expect(activities()[0]).toMatchObject({ status: 'failed', outcome: rich`exit 1` });
  });
});

describe('waitActivity', () => {
  afterEach(() => vi.useRealTimers());

  it('counts down while waiting, then is done', async () => {
    vi.useFakeTimers();
    const outcomes: (string | null)[] = [];
    let last: readonly Activity[] = [];
    const log = activityLog((activities) => {
      last = activities;
      outcomes.push(activities[0]!.outcome && plainText(activities[0]!.outcome));
    });

    const waiting = waitActivity(log, 'wait', null, 2);
    await vi.advanceTimersByTimeAsync(2000);
    await waiting;

    expect(outcomes).toEqual(['2s', '2s', '1s', null]);
    expect(last[0]!.status).toBe('done');
  });
});
