import type { Activity, ActivityStatus } from '@switch-console/shared';
import { formatDistanceToNowStrict } from 'date-fns';
import { Check, ChevronRight, Clock, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Spinner } from '@renderer/lib/ui/spinner';
import { cn } from '@renderer/utils/utils';
import type { ProviderSetupRun } from '@shared/core/provider-setup/provider-setup';
import { Rich } from './rich';

const STATUS_COLOR: Record<ActivityStatus, string> = {
  working: 'text-foreground-muted',
  waiting: 'text-foreground-warning',
  done: 'text-foreground-muted',
  failed: 'text-foreground-destructive',
};

/** "just now", "3 minutes ago", …, kept up to date while shown. */
function Ago({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const label = now - at < 60_000 ? 'just now' : formatDistanceToNowStrict(at, { addSuffix: true });
  return <time dateTime={new Date(at).toISOString()}>{label}</time>;
}

function StatusIcon({ status }: { status: ActivityStatus }) {
  const className = cn('size-3.5 shrink-0', STATUS_COLOR[status]);
  if (status === 'working') return <Spinner size="sm" className={className} />;
  if (status === 'waiting') return <Clock className={className} />;
  if (status === 'done') return <Check className={className} />;
  return <X className={className} />;
}

/** The caret of something that opens: shown on hover while shut, always while open. */
function Caret({ open }: { open: boolean }) {
  return (
    <span
      className={cn(
        'flex h-4 shrink-0 items-center transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100',
        open ? 'opacity-100' : 'opacity-0'
      )}
    >
      <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
    </span>
  );
}

/** One activity on a line; one with a description opens to it. */
function ActivityRow({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const title = (
    <>
      <span className="min-w-0 truncate" title={activity.title}>
        {activity.title}…
      </span>
      {activity.description && <Caret open={open} />}
    </>
  );
  return (
    <div>
      <div className="flex items-baseline gap-3">
        {activity.description ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="group flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground"
          >
            {title}
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1">{title}</span>
        )}
        {/* The status sits with the outcome, on the right: a spinner while it runs. */}
        <span className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap">
          <span className="relative top-0.5">
            <StatusIcon status={activity.status} />
          </span>
          {activity.outcome && (
            <span>
              <Rich text={activity.outcome} />
            </span>
          )}
        </span>
      </div>
      {open && activity.description && (
        <div className="pl-3 break-words whitespace-pre-wrap">
          <Rich text={activity.description} />
        </div>
      )}
    </div>
  );
}

/**
 * What was done under the hood: the activities of `run`. Shut by default,
 * and labelled with what is going on, or how it last ended.
 */
export function RunDetails({ run }: { run: ProviderSetupRun | undefined }) {
  if (!run || run.activities.length === 0) return null;
  // Activities can overlap, so the current one is the latest still going.
  const current = run.activities.findLast(
    (activity) => activity.status === 'working' || activity.status === 'waiting'
  );
  const label =
    run.finishedAt === null && current ? (
      `${current.title}…`
    ) : run.summary !== null && run.finishedAt !== null ? (
      <>
        {run.summary} <Ago at={run.finishedAt} />
      </>
    ) : (
      `${run.activities.at(-1)!.title}…`
    );
  return (
    <Disclosure label={label}>
      {run.activities.map((activity) => (
        <ActivityRow key={activity.id} activity={activity} />
      ))}
    </Disclosure>
  );
}

/** A quiet one-line label that opens to more under it. The caret shows on hover while shut. */
export function Disclosure({ label, children }: { label: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="group flex items-start gap-1 text-left text-xs text-foreground-muted hover:text-foreground"
      >
        <span className="min-w-0 break-words">{label}</span>
        <Caret open={open} />
      </button>
      {open && (
        <div className="mt-0.5 pl-3 text-xs leading-snug text-foreground-muted">{children}</div>
      )}
    </div>
  );
}
