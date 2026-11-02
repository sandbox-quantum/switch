import { cn } from '@renderer/utils/utils';
import {
  resetsAt,
  STOP_REASON_WORDS,
  type StopReason,
  stopReasonHeading,
} from '@shared/core/stop-reasons/stop-reasons';

/** "Today at 10:42", "Yesterday at 18:05" or "3 Nov at 09:12", in the person's own time. */
export function happenedAt(iso: string, now: Date): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  return `${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} at ${time}`;
}

/**
 * Why the agent stopped or can't take work, on its page (visibility V2, spec U1): the heading, when it happened,
 * one "What to do" line and, where it helps, Restart agent. Only the fixed words for the server's code, never
 * anything the agent or its box wrote.
 */
export function AgentStatusPanel({
  reason,
  now,
  waitLimitMinutes = 10,
  onRestart,
  restarting = false,
}: {
  reason: StopReason;
  now: Date;
  waitLimitMinutes?: number;
  onRestart?: () => void;
  restarting?: boolean;
}) {
  const words = STOP_REASON_WORDS[reason.code];
  const when = [
    reason.since ? happenedAt(reason.since, now) : null,
    reason.resetAt && (reason.code === 'daily_cap_reached' || reason.code === 'budget_reached')
      ? resetsAt(reason.resetAt)
      : null,
  ].filter((part): part is string => part !== null);
  return (
    <section
      aria-label="Status"
      className={cn(
        'mx-1 mb-4 rounded-lg border px-3 py-2.5 text-left text-sm',
        words.tone === 'problem' && 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950',
        words.tone === 'waking' &&
          'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950',
        words.tone === 'off' && 'border-border-1 bg-background-2'
      )}
    >
      <h3
        className={cn(
          'font-semibold',
          words.tone === 'problem' && 'text-red-700 dark:text-red-300',
          words.tone === 'waking' && 'text-amber-800 dark:text-amber-300',
          words.tone === 'off' && 'text-foreground'
        )}
      >
        {stopReasonHeading(reason.code, waitLimitMinutes)}
      </h3>
      {when.length > 0 && <p className="text-xs text-foreground-muted">{when.join(' · ')}</p>}
      <p className="mt-1.5 text-foreground">
        <span className="font-semibold">What to do:</span> {words.whatToDo}
      </p>
      {words.restartHelps && onRestart && (
        <button
          type="button"
          onClick={onRestart}
          disabled={restarting}
          className="mt-2 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
        >
          Restart agent
        </button>
      )}
    </section>
  );
}
