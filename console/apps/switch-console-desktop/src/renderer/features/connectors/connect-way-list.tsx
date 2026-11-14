import { KeyRound, ShieldCheck } from 'lucide-react';
import type { ConnectWay, ConnectWayName } from '@renderer/features/connectors/connect-flow';
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
        return (
          <button
            key={way.way}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={busy}
            onClick={() => onPick(way.way)}
            className={cn(
              'flex w-full gap-3 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed',
              on ? 'border-foreground/40 bg-background-2' : 'hover:bg-background-2/60'
            )}
          >
            <span
              aria-hidden
              className={cn(
                'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                on && 'border-foreground'
              )}
            >
              {on && <span className="size-2 rounded-full bg-foreground" />}
            </span>
            <span className="space-y-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon aria-hidden className="size-4 text-foreground-muted" />
                {way.title}
              </span>
              <span className="block text-xs text-foreground-muted">{way.line}</span>
              {way.lasts && (
                <span className="block text-xs text-foreground-muted">{way.lasts}</span>
              )}
              {way.bestFor && (
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
