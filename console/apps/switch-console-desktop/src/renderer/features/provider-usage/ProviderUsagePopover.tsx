import type {
  ProviderSubscriptionUsageSnapshot,
  SubscriptionUsageCredit,
} from '@switch-console/agent-providers';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import {
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
} from '@renderer/lib/ui/popover';
import { cn } from '@renderer/utils/utils';
import type { AgentProviderDefinition } from '@shared/core/providers/agent-provider-registry';
import {
  formatPercentage,
  formatReset,
  formatUpdatedAt,
  formatUsageNumber,
  type PercentageDisplay,
} from './format-usage';
import { UsageMeter, usageButtonClass } from './ProviderUsageChip';

export interface ProviderReading {
  provider: AgentProviderDefinition;
  snapshot: ProviderSubscriptionUsageSnapshot;
}

const sourceLabels = { cli: 'CLI', rpc: 'CLI app server', api: 'API', oauth: 'OAuth' };

function useUsageClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function UsageRow({
  label,
  used,
  resetsAt,
  now,
  display,
  unlimited,
}: {
  label: string;
  used: number;
  resetsAt: number | null;
  now: number;
  display: PercentageDisplay;
  unlimited?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 break-words">{label}</span>
        <span className="shrink-0 text-foreground-passive tabular-nums">
          {unlimited ? 'Unlimited' : formatPercentage(used, display)}
        </span>
      </div>
      {!unlimited && <UsageMeter used={used} />}
      {resetsAt !== null && (
        <p className="text-xs text-foreground-passive">{formatReset(resetsAt, now)}</p>
      )}
    </div>
  );
}

function usageCreditLabel(credit: SubscriptionUsageCredit): string | null {
  if (!credit.enabled) return null;
  const unit = credit.unit === 'credits' ? 'credits' : (credit.currencyCode ?? '');
  if (credit.unlimited)
    return credit.unit === 'credits' ? 'Unlimited credits' : 'Unlimited extra usage';
  if (credit.balance != null) return `${formatUsageNumber(credit.balance)} ${unit} remaining`;
  if (credit.spent != null && credit.limit != null)
    return `${formatUsageNumber(credit.spent)} of ${formatUsageNumber(credit.limit)} ${unit} used`;
  return null;
}

function ProviderDetails({
  reading,
  display,
  now,
  refreshing,
  refresh,
  openProviders,
}: {
  reading: ProviderReading;
  display: PercentageDisplay;
  now: number;
  refreshing: boolean;
  refresh: () => void;
  openProviders: () => void;
}) {
  const { provider, snapshot } = reading;
  const credit = snapshot.extraUsage && usageCreditLabel(snapshot.extraUsage);
  const groups = Map.groupBy(
    snapshot.buckets ?? [],
    (bucket) => bucket.group ?? 'Additional limits'
  );
  const waiting = (snapshot.retryAt ?? 0) > now;
  return (
    <section aria-label={provider.name} className="space-y-2.5">
      <div className="flex items-center gap-2">
        <AgentIcon id={provider.id} size={16} />
        <h3 className="flex-1 font-medium">{provider.name}</h3>
        {snapshot.planLabel && (
          <span className="rounded bg-foreground/10 px-1.5 text-xs">{snapshot.planLabel}</span>
        )}
        {snapshot.source && (
          <span className="text-xs text-foreground-passive">{sourceLabels[snapshot.source]}</span>
        )}
        <button
          type="button"
          className={usageButtonClass}
          disabled={refreshing || waiting}
          aria-label={`Refresh ${provider.name} usage`}
          onClick={refresh}
        >
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
        </button>
      </div>
      {snapshot.updatedAt !== null && (
        <p
          className="text-xs text-foreground-passive"
          title={new Date(snapshot.updatedAt).toLocaleString()}
        >
          {snapshot.stale ? 'Cached reading from ' : 'Updated '}
          {formatUpdatedAt(snapshot.updatedAt, now)}
        </p>
      )}
      {snapshot.staleError && (
        <p className="text-xs text-foreground-warning">{snapshot.staleError}</p>
      )}
      {waiting && snapshot.retryAt != null && (
        <p className="text-xs text-foreground-passive">
          Retry after{' '}
          {new Date(snapshot.retryAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}
          .
        </p>
      )}
      {snapshot.status === 'ok' ? (
        <>
          {snapshot.windows.map((window) => (
            <UsageRow
              key={window.id}
              label={window.label}
              used={window.usedPercent}
              resetsAt={window.resetsAt}
              now={now}
              display={display}
            />
          ))}
          {[...groups].map(([group, buckets]) => (
            <div key={group} className="space-y-2 rounded border border-[var(--hair)] px-2 py-1.5">
              <h4 className="font-medium">{group}</h4>
              {buckets.map((bucket, index) => (
                <UsageRow
                  key={index}
                  label={bucket.name}
                  used={bucket.usedPercent}
                  resetsAt={bucket.resetsAt}
                  now={now}
                  display={display}
                  unlimited={bucket.unlimited}
                />
              ))}
            </div>
          ))}
          {credit && <p>{credit}</p>}
          {!credit && snapshot.windows.length === 0 && groups.size === 0 && (
            <p>No quota details were reported.</p>
          )}
        </>
      ) : (
        <p className="text-foreground-passive">
          {snapshot.message ?? (refreshing ? 'Checking usage…' : 'No usage reading yet.')}
        </p>
      )}
      {snapshot.status === 'unauthenticated' && (
        <PopoverClose className={usageButtonClass} onClick={openProviders}>
          Open Agent providers
        </PopoverClose>
      )}
    </section>
  );
}

interface UsagePopoverProps {
  readings: ProviderReading[];
  unsupported: AgentProviderDefinition[];
  refreshingIds: string[];
  display: PercentageDisplay;
  refresh: (id?: string) => void;
  openProviders: () => void;
  error: boolean;
}

export function ProviderUsagePopover(props: UsagePopoverProps) {
  return (
    <PopoverContent
      side="top"
      sideOffset={6}
      align="start"
      className="max-h-[min(32rem,var(--available-height))] w-[min(22rem,var(--available-width))] gap-3 overflow-y-auto text-xs"
    >
      <UsagePopoverBody {...props} />
    </PopoverContent>
  );
}

function UsagePopoverBody({
  readings,
  unsupported,
  refreshingIds,
  display,
  refresh,
  openProviders,
  error,
}: UsagePopoverProps) {
  const now = useUsageClock();
  return (
    <>
      <div>
        <PopoverTitle className="text-sm">Local machine usage</PopoverTitle>
        {error && <PopoverDescription>Could not load usage. Try refreshing.</PopoverDescription>}
      </div>
      <div className="space-y-3 divide-y divide-[var(--hair)]">
        {readings.map((reading) => (
          <div key={reading.provider.id} className="pb-3 last:pb-0">
            <ProviderDetails
              reading={reading}
              display={display}
              now={now}
              refreshing={refreshingIds.includes(reading.provider.id)}
              refresh={() => refresh(reading.provider.id)}
              openProviders={openProviders}
            />
          </div>
        ))}
      </div>
      {unsupported.length > 0 && (
        <div className="space-y-1 border-t border-[var(--hair)] pt-2">
          <h3 className="font-medium">Other installed providers (no local usage API)</h3>
          <p className="text-foreground-passive">
            {unsupported.map(({ name }) => name).join(', ')}
          </p>
        </div>
      )}
    </>
  );
}
