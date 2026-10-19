import { ExternalLink } from 'lucide-react';
import { useEffect } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Switch } from '@renderer/lib/ui/switch';
import { TELEMETRY_DETAILS_URL } from './telemetry-copy';

/**
 * Sharing usage data, for the first-run pages that say so instead of the
 * notice that used to open over the app. Shown is told: the answer counts as
 * given once one of these is on screen, so Settings is where it changes later.
 */
function useUsageData() {
  const { value, update, isLoading, isSaving } = useAppSettingsKey('telemetry');
  const askedAt = value?.askedAt ?? null;
  const enabled = value?.enabled ?? true;
  useEffect(() => {
    if (value && askedAt === null) update({ enabled, askedAt: Date.now() });
  }, [value, askedAt, enabled, update]);
  return {
    enabled,
    busy: isLoading || isSaving,
    set: (next: boolean) => update({ enabled: next, askedAt: askedAt ?? Date.now() }),
  };
}

function LearnMore() {
  return (
    <button
      type="button"
      className="inline-flex cursor-pointer items-center gap-1 bg-transparent p-0 text-foreground-muted underline-offset-2 hover:bg-transparent hover:text-foreground hover:underline"
      onClick={() => {
        void openExternalUrl(TELEMETRY_DETAILS_URL, 'Could not open the telemetry document');
      }}
    >
      Learn more
      <ExternalLink aria-hidden className="size-3" />
    </button>
  );
}

/**
 * One settings line on the page that starts a Switch server here: the same
 * answer covers that server, which reads it when it starts.
 */
export function UsageDataToggle() {
  const usage = useUsageData();
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-foreground">
        <label htmlFor="usage-data-toggle">Share anonymous usage data</label>
        <span className="text-xs">
          <LearnMore />
        </span>
      </p>
      <Switch
        id="usage-data-toggle"
        checked={usage.enabled}
        disabled={usage.busy}
        onCheckedChange={usage.set}
        className="data-checked:bg-foreground-success [&[data-checked]:not([data-disabled]):hover]:bg-foreground-success/85"
      />
    </div>
  );
}

/** The welcome page's line about it, for every way Switch is then run. */
export function UsageDataNotice() {
  const usage = useUsageData();
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-1.5 text-xs text-foreground-muted">
      <span>
        {usage.enabled
          ? 'Switch Console shares anonymous usage data to improve the app.'
          : 'Switch Console does not share usage data.'}
      </span>
      <LearnMore />
      <span aria-hidden>·</span>
      <button
        type="button"
        disabled={usage.busy}
        className="cursor-pointer bg-transparent p-0 font-medium text-foreground-muted underline-offset-2 hover:bg-transparent hover:text-foreground hover:underline"
        onClick={() => usage.set(!usage.enabled)}
      >
        {usage.enabled ? 'Turn off' : 'Turn on'}
      </button>
    </p>
  );
}
