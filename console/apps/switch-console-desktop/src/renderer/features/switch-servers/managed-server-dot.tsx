import { LoaderCircle } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { cn } from '@renderer/utils/utils';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { type ManagedTone, managedServerState } from './managed-server-state';

export const TONE_DOT: Record<ManagedTone, string> = {
  running: 'bg-[var(--srv-running)]',
  working: 'bg-[var(--srv-working)]',
  attention: 'bg-[var(--srv-working)]',
  stopped: 'bg-[var(--srv-stopped)]',
  failed: 'bg-[var(--srv-failed)]',
};

/** The pill's wash and the text on it. */
export const TONE_PILL: Record<ManagedTone, string> = {
  running: 'bg-[var(--srv-running-tint)] text-[var(--srv-running-text)]',
  working: 'bg-[var(--srv-working-tint)] text-[var(--srv-working-text)]',
  attention: 'bg-[var(--srv-working-tint)] text-[var(--srv-working-text)]',
  stopped: 'bg-[var(--srv-stopped-tint)] text-[var(--srv-stopped-text)]',
  failed: 'bg-[var(--srv-failed-tint)] text-[var(--srv-failed-text)]',
};

/** A message box or banner: the same hue as the pill, fainter, with a hairline. */
export const TONE_BOX: Record<ManagedTone, string> = {
  running: 'border-[var(--srv-stopped-line)] bg-[var(--srv-stopped-box)]',
  working: 'border-[var(--srv-working-line)] bg-[var(--srv-working-box)]',
  attention: 'border-[var(--srv-working-line)] bg-[var(--srv-working-box)]',
  stopped: 'border-[var(--srv-stopped-line)] bg-[var(--srv-stopped-box)]',
  failed: 'border-[var(--srv-failed-line)] bg-[var(--srv-failed-box)]',
};

/** The title of a message box, in the box's hue. */
export const TONE_TITLE: Record<ManagedTone, string> = {
  running: 'text-foreground',
  working: 'text-[var(--srv-working-text)]',
  attention: 'text-[var(--srv-working-text)]',
  stopped: 'text-foreground',
  failed: 'text-[var(--srv-failed-text)]',
};

/** The amber spinner that stands in for a dot while a server changes state. */
export function WorkingSpinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      aria-hidden
      className={cn('size-[11px] shrink-0 animate-spin text-[var(--srv-working)]', className)}
    />
  );
}

export function ToneDot({ tone, size }: { tone: ManagedTone; size: 6 | 7 }) {
  if (tone === 'working') return <WorkingSpinner />;
  return (
    <span
      aria-hidden
      className={cn(
        'shrink-0 rounded-full',
        size === 6 ? 'size-1.5' : 'size-[7px]',
        TONE_DOT[tone]
      )}
    />
  );
}

/**
 * A managed server's state as a dot — or a spinner while it changes state —
 * with no words: the switcher and the sidebar say how a server is with colour
 * alone. Nothing for a server this Console does not run, or before its state
 * has been read.
 */
export const ManagedServerDot = observer(function ManagedServerDot({
  server,
  size,
}: {
  server: SwitchServer;
  size: 6 | 7;
}) {
  const state = managedServerState(server);
  if (!state || !state.known) return null;
  return (
    <span role="img" aria-label={state.label} title={state.label} className="flex shrink-0">
      <ToneDot tone={state.tone} size={size} />
    </span>
  );
});
