import type { ReactNode } from 'react';
import { Button } from '@renderer/lib/ui/button';

/** The lifecycle states a managed stack reports, local or remote. */
export type StackPhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'unreachable';

const PHASE_LABEL: Record<StackPhase, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  error: 'Error',
  unreachable: 'Host unreachable',
};

const PHASE_DOT: Record<StackPhase, string> = {
  stopped: 'bg-foreground-muted',
  starting: 'bg-amber-500',
  running: 'bg-green-500',
  stopping: 'bg-amber-500',
  error: 'bg-red-500',
  unreachable: 'bg-amber-500',
};

/**
 * The managed stack's own section of a server page — a heading, a one-line
 * status, and whatever the stack currently has to say for itself.
 *
 * Shared by the local and remote controls so the two read as the same thing in
 * two places rather than as two features that happen to look alike.
 */
export function StackSection({ children }: { children: ReactNode }) {
  return <section className="space-y-3">{children}</section>;
}

/**
 * Where the stack is and what can be done about it.
 *
 * `summary` is a sentence rather than the machine's own terse answer — the
 * heading above it already says which stack this is, so the line's job is to
 * say whether it is up and where. The deployed version is carried on its
 * `title` instead of on screen: it is worth having, but only when something has
 * gone wrong enough to look for it, and the drift notice states both versions
 * whenever they actually disagree.
 */
export function StackStatusRow({
  title,
  phase,
  summary,
  versionDetail,
  activity,
  actions,
}: {
  title: string;
  phase: StackPhase;
  summary: string;
  versionDetail: string | null;
  /** The "Recent activity" disclosure, when there is any output to disclose. */
  activity?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-foreground-muted">
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${PHASE_DOT[phase]}`} />
          <span className="truncate" title={versionDetail ?? undefined}>
            {summary}
          </span>
          {activity && (
            <>
              <span aria-hidden>·</span>
              {activity}
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">{actions}</div>
    </div>
  );
}

/** A stack lifecycle action. Bordered rather than bare text: starting, stopping
 * and restarting a server are consequential enough to look pressable, and a
 * red word with no edge to it reads as a status rather than a control. */
export function StackAction({
  label,
  danger = false,
  disabled = false,
  onClick,
}: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onClick}
      className={
        danger ? 'border-red-500/40 text-red-500 hover:bg-red-500/10 hover:text-red-500' : undefined
      }
    >
      {label}
    </Button>
  );
}

/** The phase's own words, for the states that are not simply "running". */
export function phaseLabel(phase: StackPhase): string {
  return PHASE_LABEL[phase];
}
