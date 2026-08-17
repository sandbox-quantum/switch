import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { userFacingProblemChannel, type UserFacingProblem } from '@shared/events/problemEvents';

/**
 * Tell the user about a background failure they would otherwise never learn of.
 *
 * Reach for this where main-process work fails in a way that changes what the
 * user should expect: the thing they are waiting for is not coming, or a
 * capability they believe is on is off. Do NOT use it for routine noise — a
 * retry that will succeed, a poll that will come round again — because a
 * problem that cannot be acted on is just a different kind of unread log line.
 *
 * It always logs as well as notifying. The log entry is the record a support
 * conversation needs; the notification is only the part the user reads, and a
 * closed window must not be able to lose the failure entirely.
 */
export function reportProblem(problem: UserFacingProblem): void {
  log.error('User-facing problem', {
    event: 'user_facing_problem',
    key: problem.key,
    headline: problem.headline,
    detail: problem.detail,
  });
  events.emit(userFacingProblemChannel, problem);
}

/** The trimmed, single-line form of a caught error, fit for `detail`. */
export function problemDetail(error: unknown): string | null {
  const raw = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  return raw.length > 0 ? raw : null;
}
