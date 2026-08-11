import { cn } from '@renderer/utils/utils';

/**
 * The small status pill used to say what state a thing is in.
 *
 * One component rather than a set of hand-rolled spans so the agents page, the
 * remote-hosts list and a host's own page read as the same product. Tone is
 * semantic, not a colour: callers say what they mean and the palette stays in
 * one place.
 */
export type StatusTone = 'success' | 'warning' | 'info' | 'danger' | 'neutral';

const TONE_CLASS: Record<StatusTone, string> = {
  success: 'bg-background-success text-foreground-success',
  warning: 'bg-background-warning text-foreground-warning',
  info: 'bg-background-info text-foreground-info',
  danger: 'bg-background-error text-foreground-error',
  neutral: 'bg-background-2 text-foreground-passive',
};

export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('rounded-md px-1.5 py-0.5 text-xs', TONE_CLASS[tone], className)}>
      {children}
    </span>
  );
}
