import { RefreshCw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Popover, PopoverTrigger } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/utils/utils';
import { agentProviders } from '@shared/core/providers/agent-provider-registry';
import { layoutUsageChips, ROSTER_CHIP_WIDTH } from './format-usage';
import { createProviderUsageStore } from './provider-usage-store';
import { ProviderUsageChip, usageButtonClass } from './ProviderUsageChip';
import { ProviderUsagePopover, type ProviderReading } from './ProviderUsagePopover';

function UsageItem({ trigger, popup }: { trigger: ReactNode; popup: ReactNode }) {
  return (
    <Popover>
      {trigger}
      {popup}
    </Popover>
  );
}

export const ProviderUsageBar = observer(function ProviderUsageBar() {
  const settings = useAppSettingsKey('interface');
  const enabled = settings.value?.showProviderUsageBar === true;
  const display = settings.value?.usagePercentageDisplay ?? 'used';
  const { navigate } = useNavigate();
  const [store] = useState(createProviderUsageStore);
  const [width, setWidth] = useState(0);
  const strip = useRef<HTMLDivElement>(null);
  const { installedProviderIds, refreshingProviderIds, snapshots } = store.state;
  const hasContent = enabled && (installedProviderIds.length > 0 || store.error);

  useEffect(() => {
    if (enabled) return store.mount();
  }, [enabled, store]);

  useLayoutEffect(() => {
    const element = strip.current;
    if (!hasContent || !element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    return () => resize.disconnect();
  }, [hasContent]);

  if (!hasContent) return null;
  const installed = agentProviders().filter(({ id }) => installedProviderIds.includes(id));
  const unsupported = installed.filter((provider) => !provider.supportsSubscriptionUsage);
  const byId = new Map(snapshots.map((snapshot) => [snapshot.providerId, snapshot]));
  const readings: ProviderReading[] = installed.flatMap((provider) => {
    const snapshot = byId.get(provider.id);
    return snapshot ? [{ provider, snapshot }] : [];
  });
  const primary = readings.filter(({ snapshot }) => snapshot.status !== 'unavailable');
  const { visibleCount, wide, showRoster } = layoutUsageChips(
    width,
    primary.length,
    store.error || primary.length !== readings.length || primary.length === 0
  );
  const overflowCount = readings.length - visibleCount;
  const refresh = (id?: string) => void store.refresh(id);
  const openProviders = () => navigate('settings', { tab: 'clis-models' });
  const details = (selected: ProviderReading[]) => (
    <ProviderUsagePopover
      readings={selected}
      unsupported={unsupported}
      refreshingIds={refreshingProviderIds}
      display={display}
      refresh={refresh}
      openProviders={openProviders}
      error={store.error}
    />
  );

  return (
    <footer
      role="region"
      aria-label="Local provider subscription usage"
      className="flex h-7 shrink-0 items-center gap-2 border-t border-[var(--hair)] bg-background-secondary px-2.5 text-[11px] [-webkit-app-region:no-drag]"
    >
      <div ref={strip} className="flex min-w-0 flex-1 items-center gap-1">
        {primary.slice(0, visibleCount).map(({ provider, snapshot }) => (
          <UsageItem
            key={provider.id}
            trigger={
              <ProviderUsageChip
                provider={provider}
                snapshot={snapshot}
                display={display}
                wide={wide}
              />
            }
            popup={details([{ provider, snapshot }])}
          />
        ))}
        {showRoster && (
          <UsageItem
            trigger={
              <PopoverTrigger
                className={usageButtonClass}
                style={{ width: ROSTER_CHIP_WIDTH }}
                aria-label={
                  overflowCount ? `Show all local usage, ${overflowCount} more` : 'Show local usage'
                }
              >
                {overflowCount ? `+${overflowCount}` : 'Usage'}
              </PopoverTrigger>
            }
            popup={details(readings)}
          />
        )}
      </div>
      <button
        type="button"
        className={usageButtonClass}
        aria-label="Show percentage remaining"
        aria-pressed={display === 'remaining'}
        disabled={settings.isSaving || readings.length === 0}
        onClick={() =>
          settings.update({ usagePercentageDisplay: display === 'used' ? 'remaining' : 'used' })
        }
      >
        {display === 'used' ? 'Used' : 'Left'}
      </button>
      <button
        type="button"
        className={usageButtonClass}
        aria-label="Refresh provider usage"
        disabled={refreshingProviderIds.length > 0 || (readings.length === 0 && !store.error)}
        onClick={() => refresh()}
      >
        <RefreshCw className={cn('size-3.5', refreshingProviderIds.length > 0 && 'animate-spin')} />
      </button>
    </footer>
  );
});
