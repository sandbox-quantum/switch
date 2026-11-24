import type { ProviderSubscriptionUsageSnapshot } from '@switch-console/agent-providers';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { PopoverTrigger } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/utils/utils';
import type { AgentProviderDefinition } from '@shared/core/providers/agent-provider-registry';
import {
  COMPACT_CHIP_WIDTH,
  WIDE_CHIP_WIDTH,
  formatPercentage,
  usageTone,
  type PercentageDisplay,
} from './format-usage';

const tones = {
  normal: 'bg-foreground/60',
  warning: 'bg-[var(--foreground-warning)]',
  error: 'bg-[var(--foreground-error)]',
};

export const usageButtonClass =
  'inline-flex h-6 shrink-0 items-center justify-center gap-1.5 rounded px-1.5 text-foreground hover:bg-foreground/10 focus-visible:outline focus-visible:outline-ring disabled:opacity-50';

export function UsageMeter({ used, className }: { used: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('block h-1.5 overflow-hidden rounded-full bg-foreground/15', className)}
    >
      <span
        className={cn('block h-full rounded-full', tones[usageTone(used)])}
        style={{ width: formatPercentage(used, 'used', true) }}
      />
    </span>
  );
}

export function ProviderUsageChip({
  provider,
  snapshot,
  display,
  wide,
}: {
  provider: AgentProviderDefinition;
  snapshot: ProviderSubscriptionUsageSnapshot;
  display: PercentageDisplay;
  wide: boolean;
}) {
  const windows = snapshot.windows.slice(0, wide ? 2 : 1);
  const label = windows
    .map(({ label, usedPercent }) => `${label} ${formatPercentage(usedPercent, display)}`)
    .join(', ');
  const stateLabel =
    snapshot.status === 'unauthenticated'
      ? 'Sign in'
      : snapshot.status === 'error'
        ? 'Usage unavailable'
        : snapshot.status === 'fetching' || snapshot.status === 'idle'
          ? 'Loading'
          : 'Usage';
  const updatedAt =
    snapshot.stale && snapshot.updatedAt !== null
      ? new Date(snapshot.updatedAt).toLocaleString()
      : null;
  return (
    <PopoverTrigger
      className={cn(usageButtonClass, 'justify-start')}
      style={{ width: wide ? WIDE_CHIP_WIDTH : COMPACT_CHIP_WIDTH }}
      aria-label={`${provider.name}, ${label || stateLabel}${updatedAt ? ', cached' : ''}`}
      title={updatedAt ? `Cached reading from ${updatedAt}` : undefined}
    >
      <span aria-hidden="true" className="inline-flex">
        <AgentIcon id={provider.id} size={13} />
      </span>
      <span aria-hidden="true" className="min-w-0 truncate font-medium">
        {provider.shortName}
      </span>
      <span
        aria-hidden="true"
        className="ml-auto inline-flex flex-none items-center gap-2 text-foreground-passive tabular-nums"
      >
        {windows.map((window) => (
          <span className="inline-flex items-center gap-1" key={window.id}>
            <UsageMeter used={window.usedPercent} className="w-7" />
            {formatPercentage(window.usedPercent, display, true)}
          </span>
        ))}
        {windows.length === 0 && (
          <>
            {snapshot.status === 'fetching' && <LoaderCircle className="size-3 animate-spin" />}
            {snapshot.status === 'error' && <TriangleAlert className="size-3" />}
            {stateLabel}
          </>
        )}
        {updatedAt && <span className="size-1.5 rounded-full bg-current" />}
      </span>
    </PopoverTrigger>
  );
}
