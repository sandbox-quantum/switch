import type { SessionStartedNotice } from '@switch-console/agent-providers';
import { agentTypeOf } from './agent-type';
import { trackEvent } from './telemetry-service';

/** Enough to recognise a start reported twice, which follows the first closely. */
const REMEMBERED_SESSIONS = 256;

const reported = new Set<string>();

/**
 * Report a session the agent controller on this computer started, once its
 * Switch server has taken the report.
 *
 * A session host stopped before it heard Switch answer reports the same start
 * again when it next runs. Within a run that is told apart by the session's id,
 * which goes no further than this set; across a restart of the app it is
 * counted twice, which is rare enough to leave.
 */
export function reportManagedSessionStarted(notice: SessionStartedNotice): void {
  if (reported.has(notice.sessionId)) return;
  reported.add(notice.sessionId);
  if (reported.size > REMEMBERED_SESSIONS) {
    const oldest = reported.values().next();
    if (!oldest.done) reported.delete(oldest.value);
  }
  trackEvent('managed_session_started', {
    agent_type: agentTypeOf(notice.provider),
    start_source: notice.startSource,
  });
}
