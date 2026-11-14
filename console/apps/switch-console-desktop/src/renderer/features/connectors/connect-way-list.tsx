import { KeyRound, ShieldCheck } from 'lucide-react';
import type { ConnectWay, ConnectWayName } from '@renderer/features/connectors/connect-flow';
import { StatusBadge } from '@renderer/lib/ui/status-badge';
import { cn } from '@renderer/utils/utils';

/**
 * The ways to connect a service, one row each, of which the person picks one
 * before going on: what each means is set out before anything is started.
 */
export function ConnectWayList({
  service,
  ways,
  picked,
  busy,
  onPick,
}: {
  service: string;
  ways: ConnectWay[];
  picked: ConnectWayName;
  busy: boolean;
  onPick: (way: ConnectWayName) => void;
}) {
  return (
    <div role="radiogroup" aria-label={`How to connect ${service}`} className="space-y-2">
      {ways.map((way) => {
        const on = way.way === picked;
        const Icon = way.way === 'sign_in' ? ShieldCheck : KeyRound;
        const shut = way.unavailable !== null;
        return (
          <button
            key={way.way}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={busy || shut}
            onClick={() => onPick(way.way)}
            className={cn(
              'flex w-full gap-3 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed',
              on ? 'border-foreground/40 bg-background-2' : !shut && 'hover:bg-background-2/60',
              shut && 'bg-background-2/60'
            )}
          >
            <span
              aria-hidden
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                on && 'border-foreground',
                shut && 'opacity-40'
              )}
            >
              {on && <span className="size-2 rounded-full bg-foreground" />}
            </span>
            <span className="space-y-1">
              <span
                className={cn(
                  'flex items-center gap-2 text-sm font-medium',
                  shut && 'text-foreground-muted'
                )}
              >
                <Icon aria-hidden className="size-4 text-foreground-muted" />
                {way.title}
                {way.recommended && (
                  <StatusBadge tone="info" className="text-[10px]">
                    Recommended
                  </StatusBadge>
                )}
                {shut && (
                  <StatusBadge tone="neutral" className="text-[10px]">
                    Not set up here
                  </StatusBadge>
                )}
              </span>
              <span className="block text-xs text-foreground-muted">{way.line}</span>
              {way.unavailable && (
                <span className="block text-xs font-medium text-foreground-muted">
                  {way.unavailable}
                </span>
              )}
              {way.lasts && (
                <span className="block text-xs text-foreground-muted">{way.lasts}</span>
              )}
              {way.bestFor && !shut && (
                <span className="block text-xs font-medium text-foreground-muted">
                  {way.bestFor}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
