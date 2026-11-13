/**
 * What a script is doing, as activities a person can follow: each activity
 * reads `[status] title… outcome` on one line, e.g.
 * `✓ Checking if command claude exists in PATH… found`, with a description
 * under it for the details (`Found at /usr/local/bin/claude`).
 *
 * A script records them through an {@link ActivityLog}, which takes each change
 * as a new whole list made from the one before: whoever shows the activities
 * replaces what it had with each list it gets. `runActivity` and `waitActivity` are
 * shorthands for the common changes, made with `addActivity` and `updateActivity`.
 */

import { lines, rich, type RichText } from './rich-text';

export type ActivityStatus = 'working' | 'waiting' | 'done' | 'failed';

export type Activity = {
  id: string;
  /**
   * What the activity does, in a few plain words that fit one line: no paths or
   * other values of unknown length, which go in `description`. Also what a
   * one-line view shows while the activity runs.
   */
  title: string;
  status: ActivityStatus;
  /** A word or two after the title, coloured by status: "found", "21s", "version 1.2.3". */
  outcome: RichText | null;
  /**
   * The detail under the title, only where the whole list is shown: the
   * command run, the path checked, and what came of it beyond the outcome
   * (the error, where it was found). May run to several lines.
   */
  description: RichText | null;
};

export type ActivityFields = Omit<Activity, 'id'>;

/** Where a script's activities go: each change makes the whole list anew from the one before. */
export type ActivityLog = (
  change: (activities: readonly Activity[]) => readonly Activity[]
) => void;

/** An activity log that keeps nothing, for scripts nobody is watching. */
export const noActivity: ActivityLog = () => {};

/** An activity log holding the activities, giving `onChange` the whole list after every change. */
export function activityLog(onChange: (activities: readonly Activity[]) => void): ActivityLog {
  let activities: readonly Activity[] = [];
  return (change) => {
    activities = change(activities);
    onChange(activities);
  };
}

let lastId = 0;

/** Appends an activity to `log`, returning its id. */
export function addActivity(log: ActivityLog, fields: ActivityFields): string {
  const id = String(++lastId);
  log((activities) => [...activities, { id, ...fields }]);
  return id;
}

/** Changes the activity `id` of `log`. */
export function updateActivity(log: ActivityLog, id: string, patch: Partial<ActivityFields>): void {
  log((activities) =>
    activities.map((activity) => (activity.id === id ? { ...activity, ...patch } : activity))
  );
}

export type ActivityUpdate = (patch: Partial<ActivityFields>) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `description` with `more` on a line of its own under it. */
export function describeFurther(description: RichText | null, more: RichText): RichText {
  return description ? lines(description, more) : more;
}

/**
 * Runs `fn` as one activity: `working` while it runs, then `done`, or `failed`
 * when it throws, with the error's message added to its description (the
 * error is rethrown).
 *
 * `fn` gets `update` for its own activity, to set an outcome ("found") or to
 * settle it itself — an activity `fn` marks `failed` stays failed when it returns.
 */
export async function runActivity<T>(
  log: ActivityLog,
  title: string,
  description: RichText | null,
  fn: (update: ActivityUpdate) => Promise<T> | T
): Promise<T> {
  const id = addActivity(log, { title, status: 'working', outcome: null, description });
  let status: ActivityStatus = 'working';
  let described = description;
  const update: ActivityUpdate = (patch) => {
    if (patch.status) status = patch.status;
    if (patch.description !== undefined) described = patch.description;
    updateActivity(log, id, patch);
  };
  try {
    const result = await fn(update);
    if (status === 'working' || status === 'waiting') updateActivity(log, id, { status: 'done' });
    return result;
  } catch (error) {
    updateActivity(log, id, {
      status: 'failed',
      outcome: rich`failed`,
      description: describeFurther(described, rich`${errorMessage(error)}`),
    });
    throw error;
  }
}

/** Waits `seconds` as one `waiting` activity counting down ("21s"), then marks it `done`. */
export async function waitActivity(
  log: ActivityLog,
  title: string,
  description: RichText | null,
  seconds: number
): Promise<void> {
  const id = addActivity(log, {
    title,
    status: 'waiting',
    outcome: rich`${seconds}s`,
    description,
  });
  for (let left = seconds; left > 0; left--) {
    updateActivity(log, id, { outcome: rich`${left}s` });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  updateActivity(log, id, { status: 'done', outcome: null });
}
