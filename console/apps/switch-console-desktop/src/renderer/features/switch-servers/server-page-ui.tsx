import type { ReactNode } from 'react';
import { cn } from '@renderer/utils/utils';
import { TONE_BOX, TONE_PILL, TONE_TITLE, ToneDot } from './managed-server-dot';
import type { ManagedServerState, ManagedTone } from './managed-server-state';

/**
 * The pieces the server page and the frozen-workspace banner are built from.
 * Their sizes are the design's, written once here rather than at each use.
 */

type ButtonProps = {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
};

/** The one primary action of a view. */
export function PrimaryButton({ children, onClick, disabled = false, className }: ButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] bg-[var(--srv-primary)] px-3 text-[13px] font-medium text-[var(--srv-primary-fg)] transition-opacity hover:opacity-90 disabled:opacity-50 [&_svg]:size-3.5',
        className
      )}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, onClick, disabled = false, className }: ButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] border-[0.5px] border-[var(--hair-strong)] px-3 text-[13px] text-foreground transition-colors hover:bg-[var(--sel-soft)] disabled:pointer-events-none disabled:text-[var(--fg-dim)] disabled:opacity-60 [&_svg]:size-3.5',
        className
      )}
    >
      {children}
    </button>
  );
}

/** The state beside the server's name. */
export function StatusPill({ state }: { state: ManagedServerState }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium',
        TONE_PILL[state.tone]
      )}
    >
      <ToneDot tone={state.tone} size={6} />
      {state.label}
    </span>
  );
}

/**
 * Something to act on or wait for. Shown only then: a healthy page has none.
 */
export function MessageBox({
  tone,
  title,
  icon,
  children,
}: {
  tone: ManagedTone;
  title?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      role={tone === 'failed' ? 'alert' : 'status'}
      className={cn('rounded-[10px] border-[0.5px] px-[14px] py-3', TONE_BOX[tone])}
    >
      {title && (
        <p className={cn('flex items-center gap-2 text-[13px] font-semibold', TONE_TITLE[tone])}>
          {icon}
          {title}
        </p>
      )}
      {children && (
        <div
          className={cn('space-y-2 text-[13px] text-[var(--srv-stopped-text)]', title && 'mt-1')}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** A raw error, version or path. */
export function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="block font-[Menlo,ui-monospace,monospace] text-[11.5px] break-words text-[var(--srv-mono)]">
      {children}
    </code>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="text-[11.5px] text-[#8A8A8A]">{children}</h3>;
}

/** One line of the details: a label on the left, its value on the right. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b-[0.5px] border-[var(--hair-soft)] py-[9px] text-[13px]">
      <span className="shrink-0 text-[var(--fg-dim)]">{label}</span>
      <span className="min-w-0 truncate text-right text-foreground">{children}</span>
    </div>
  );
}

/** One line of recent activity: what happened, then who and when. */
export function ActivityRow({ what, when }: { what: string; when: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-[7px] text-[13px]">
      <span className="min-w-0 truncate text-foreground">{what}</span>
      <span className="shrink-0 text-[var(--fg-dim)] opacity-75">{when}</span>
    </div>
  );
}
