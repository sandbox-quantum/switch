import type { Session } from '@switch-console/shared/session-v1';
import { observer } from 'mobx-react-lite';
import { cloudOperationAttempts, startAttemptKey } from './cloud-operation-attempts';

/**
 * A new session whose start was never confirmed. Once the worker lists the
 * session it offers to open it; until then it asks again for the same session,
 * which the server dedupes, rather than starting another. Renders nothing
 * unless the agent's start attempt is in that state.
 */
export const CloudStartAttemptStatus = observer(function CloudStartAttemptStatus({
  agentKey,
  sessions,
  onOpen,
  onCheckAgain,
  className,
}: {
  agentKey: string;
  sessions: Session[];
  onOpen: (sessionId: string) => void;
  onCheckAgain: () => void;
  className: string;
}) {
  const attemptKey = startAttemptKey(agentKey);
  const attempt = cloudOperationAttempts.get(attemptKey);
  if (attempt?.status !== 'unknown') return null;
  const unconfirmed = sessions.find((session) => session.sessionId === attempt.sessionId);
  return (
    <div
      role="status"
      className={`flex items-center gap-2 text-xs text-foreground-muted ${className}`}
    >
      <span className="min-w-0">
        {unconfirmed
          ? 'The new session was not confirmed, but it exists.'
          : `Not yet known whether the new session started. ${attempt.message ?? ''}`}
      </span>
      {unconfirmed ? (
        <button
          type="button"
          className="shrink-0 underline hover:text-foreground"
          onClick={() => {
            cloudOperationAttempts.settle(attemptKey);
            onOpen(attempt.sessionId);
          }}
        >
          Open
        </button>
      ) : (
        <button
          type="button"
          className="shrink-0 underline hover:text-foreground"
          title="Asks again for the same session, so it cannot start a second one."
          onClick={onCheckAgain}
        >
          Check again
        </button>
      )}
    </div>
  );
});
