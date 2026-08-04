import {
  AlertTriangle,
  ArrowRight,
  ArrowUp,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { appState } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@renderer/lib/ui/popover';
import { Progress } from '@renderer/lib/ui/progress';
import {
  type UpdateActionKind,
  type UpdateIndicatorIcon,
  type UpdateTone,
  presentUpdate,
} from '@renderer/lib/updates/update-presentation';
import { cn } from '@renderer/utils/utils';

const TONE_TRIGGER_STYLES: Record<UpdateTone, string> = {
  neutral: 'text-foreground-passive hover:text-foreground',
  info: 'border border-border-info bg-background-info text-foreground-info hover:bg-background-info-hover',
  success:
    'border border-border-success bg-background-success text-foreground-success hover:bg-background-success-hover',
  warning:
    'border border-border-warning bg-background-warning text-foreground-warning hover:bg-background-warning-hover',
};

const INDICATOR_ICONS: Record<UpdateIndicatorIcon, React.ComponentType<{ className?: string }>> = {
  none: () => null,
  available: ArrowUp,
  downloading: Loader2,
  restart: RefreshCw,
  alert: AlertTriangle,
};

const ACTION_ICONS: Record<UpdateActionKind, React.ComponentType<{ className?: string }> | null> = {
  none: null,
  download: Download,
  restart: RefreshCw,
  retry: RefreshCw,
  check: RefreshCw,
};

export const UpdateSection = observer(function UpdateSection() {
  const update = appState.update;
  const presentation = presentUpdate(update.state, update.currentVersion);
  const IndicatorIcon = INDICATOR_ICONS[presentation.indicatorIcon];
  const ActionIcon = ACTION_ICONS[presentation.actionKind];
  const isNeutral = presentation.tone === 'neutral';

  function runAction(): void {
    switch (presentation.actionKind) {
      case 'download':
        void update.download();
        break;
      case 'restart':
        void update.install();
        break;
      case 'retry':
        // A failed download can be retried directly; a failed check has no
        // version to retry against, so go back through the check.
        if (update.latestVersion) void update.download();
        else void update.check();
        break;
      case 'check':
        void update.check();
        break;
      default:
        break;
    }
  }

  return (
    <Popover>
      <PopoverTrigger
        aria-label={`${presentation.title}. Open update details.`}
        className={cn(
          'relative inline-flex h-6 cursor-pointer items-center gap-1.5 overflow-hidden rounded-full px-2 text-[11px] font-medium transition-colors',
          isNeutral && 'lowercase',
          TONE_TRIGGER_STYLES[presentation.tone]
        )}
      >
        {/* While downloading, the fill doubles as the progress bar so the row
            reports progress without needing the panel open. */}
        {presentation.progressPercent !== null && presentation.busy && (
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 bg-foreground-info/15 transition-[width] duration-300 ease-out"
            style={{ width: `${presentation.progressPercent}%` }}
          />
        )}
        <span className="relative inline-flex items-center gap-1.5">
          <IndicatorIcon
            className={cn('size-3', presentation.indicatorIcon === 'downloading' && 'animate-spin')}
          />
          {presentation.indicatorLabel}
        </span>
      </PopoverTrigger>

      {/* Kept narrower than the sidebar so it can align to the indicator
          instead of being flipped away from it to avoid overflow. */}
      <PopoverContent side="top" align="end" sideOffset={8} className="w-64 gap-3">
        <PopoverHeader>
          <PopoverTitle className="flex items-center gap-2">
            {presentation.busy && <Loader2 className="size-3.5 animate-spin" />}
            {presentation.title}
          </PopoverTitle>

          {update.state.status === 'available' && update.latestVersion ? (
            <div className="flex items-center gap-2 font-mono text-xs">
              <span className="text-foreground-passive">v{update.currentVersion}</span>
              <ArrowRight className="size-3 text-foreground-passive" />
              <span className="text-foreground">v{update.latestVersion}</span>
            </div>
          ) : (
            presentation.detail && (
              <PopoverDescription
                className={cn(
                  'text-xs',
                  presentation.tone === 'warning' && 'text-foreground-warning'
                )}
              >
                {presentation.detail}
              </PopoverDescription>
            )
          )}
        </PopoverHeader>

        {presentation.progressPercent !== null && update.state.status === 'downloading' && (
          <Progress value={presentation.progressPercent} />
        )}

        {/* Stacked rather than side by side: the panel is narrower than the
            sidebar, and the two labels do not fit on one row. */}
        <div className="flex flex-col gap-2">
          {presentation.actionLabel && (
            <Button size="xs" variant="default" className="w-full" onClick={runAction}>
              {ActionIcon && <ActionIcon className="size-3.5" />}
              {presentation.actionLabel}
            </Button>
          )}

          {update.latestVersion && (
            <button
              type="button"
              onClick={() => void update.openReleasePage()}
              className="inline-flex cursor-pointer items-center justify-center gap-1 text-xs text-foreground-passive underline-offset-2 hover:text-foreground hover:underline"
            >
              Release notes
              <ExternalLink className="size-3" />
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});
