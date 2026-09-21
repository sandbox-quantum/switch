import { cn } from '@renderer/utils/utils';
import type { SessionStateTone } from './session-state';

const TONES: Record<SessionStateTone, { pill: string; dot: string }> = {
  ready: { pill: 'bg-success/10 text-foreground-success', dot: 'bg-foreground-success' },
  busy: { pill: 'bg-foreground/5 text-foreground-muted', dot: 'bg-foreground-muted' },
  bad: { pill: 'bg-destructive/10 text-foreground-destructive', dot: 'bg-foreground-destructive' },
  idle: { pill: 'bg-foreground/5 text-foreground-muted', dot: 'bg-foreground-muted' },
};

/** The session's state, against its name in the header. */
export function SessionStatePill({ label, tone }: { label: string; tone: SessionStateTone }) {
  const style = TONES[tone];
  return (
    <span
      role="status"
      className={cn(
        'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs whitespace-nowrap',
        style.pill
      )}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', style.dot)} />
      {label}
    </span>
  );
}
