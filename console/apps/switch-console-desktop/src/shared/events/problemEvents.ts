import { defineEvent } from '@shared/lib/ipc/events';

/**
 * Something went wrong that the user needs to know about, discovered in the
 * main process where there is no screen to say it on.
 *
 * The gap this closes is the opposite of a leaked exception: background work
 * that fails, logs a warning, and leaves the UI looking healthy. A session that
 * is never spawned, a room poller that never starts, a message that is never
 * injected — each of those ends with the user waiting for something that is not
 * coming, and until now the only record was a line in a log file they have no
 * way to open.
 */
export type UserFacingProblem = {
  /**
   * Identifies the condition, not the occurrence. Repeats of the same problem
   * replace each other rather than stacking up: a poller retrying against a
   * host that is down would otherwise bury the screen.
   */
  key: string;
  /** The sentence the user reads. Never raw exception text. */
  headline: string;
  /** Diagnostic detail, shown under the headline. Null when there is none. */
  detail: string | null;
};

export const userFacingProblemChannel = defineEvent<UserFacingProblem>('app:user-facing-problem');
