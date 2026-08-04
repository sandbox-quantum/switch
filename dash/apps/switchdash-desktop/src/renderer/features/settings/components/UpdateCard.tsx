import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { appState } from '@renderer/lib/stores/app-state';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { Progress } from '@renderer/lib/ui/progress';
import {
  type UpdateActionKind,
  type UpdateTone,
  presentUpdate,
} from '@renderer/lib/updates/update-presentation';
import { cn } from '@renderer/utils/utils';
import { SettingRow } from './SettingRow';

const TONE_TEXT_STYLES: Record<UpdateTone, string> = {
  neutral: 'text-muted-foreground',
  info: 'text-muted-foreground',
  success: 'text-foreground-success',
  warning: 'text-foreground-warning',
};

const ACTION_ICONS: Record<UpdateActionKind, React.ComponentType<{ className?: string }> | null> = {
  none: null,
  download: Download,
  restart: RefreshCw,
  retry: RefreshCw,
  check: RefreshCw,
};

export const UpdateCard = observer(function UpdateCard(): React.JSX.Element {
  const update = appState.update;
  const presentation = presentUpdate(update.state, update.currentVersion);
  const ActionIcon = ACTION_ICONS[presentation.actionKind];

  const isInstalling = update.state.status === 'installing';
  const isDownloaded = update.state.status === 'downloaded';
  const showRecheck = !isDownloaded && !isInstalling && presentation.actionKind !== 'check';

  function runAction(): void {
    switch (presentation.actionKind) {
      case 'download':
        void update.download();
        break;
      case 'restart':
        void update.install();
        break;
      case 'retry':
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

  const versionTitle = (
    <div className="flex items-center gap-2">
      Version
      {update.currentVersion && (
        <Badge variant="outline" className="h-5 px-2 font-mono text-xs">
          v{update.currentVersion}
        </Badge>
      )}
      {update.latestVersion && update.latestVersion !== update.currentVersion && (
        <>
          <ArrowRight className="size-3 text-foreground-passive" />
          <Badge
            variant="outline"
            className="h-5 border-border-info bg-background-info px-2 font-mono text-xs text-foreground-info"
          >
            v{update.latestVersion}
          </Badge>
        </>
      )}
    </div>
  );

  return (
    <div className="grid gap-3">
      <SettingRow
        title={versionTitle}
        description={
          <div className="flex flex-col gap-1">
            <p
              className={cn(
                'flex items-center gap-1.5 text-sm',
                TONE_TEXT_STYLES[presentation.tone]
              )}
            >
              {renderStatusIcon()}
              {presentation.title}
            </p>
            {presentation.detail && (
              <p className={cn('text-sm', TONE_TEXT_STYLES[presentation.tone])}>
                {presentation.detail}
              </p>
            )}
            {update.latestVersion && (
              <button
                type="button"
                onClick={() => void update.openReleasePage()}
                className="inline-flex w-fit cursor-pointer items-center gap-1 text-xs text-foreground-passive underline-offset-2 hover:text-foreground hover:underline"
              >
                Release notes
                <ExternalLink className="size-3" />
              </button>
            )}
          </div>
        }
        className="items-center rounded-lg border p-4"
        control={
          <div className="flex items-center gap-2">
            {showRecheck && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => void update.check()}
                disabled={update.state.status === 'checking'}
                aria-label="Check for updates"
              >
                <RefreshCw
                  className={cn('size-4', update.state.status === 'checking' && 'animate-spin')}
                />
              </Button>
            )}
            {presentation.actionLabel && (
              <Button
                variant={presentation.tone === 'warning' ? 'outline' : 'default'}
                onClick={runAction}
                disabled={presentation.busy}
              >
                {presentation.busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  ActionIcon && <ActionIcon className="size-4" />
                )}
                {presentation.actionLabel}
              </Button>
            )}
            {presentation.busy && !presentation.actionLabel && (
              <Button variant="outline" disabled>
                <Loader2 className="size-4 animate-spin" />
                {presentation.title}
              </Button>
            )}
          </div>
        }
      />

      {update.state.status === 'downloading' && presentation.progressPercent !== null && (
        <Progress value={presentation.progressPercent} />
      )}
    </div>
  );

  function renderStatusIcon(): React.ReactNode {
    if (presentation.busy) return <Loader2 className="size-3 animate-spin" />;
    if (presentation.tone === 'warning') return <AlertTriangle className="size-3" />;
    if (presentation.tone === 'success') return <CheckCircle2 className="size-3" />;
    if (update.state.status === 'idle' || update.state.status === 'not-available') {
      return <CheckCircle2 className="size-3 text-foreground-success" />;
    }
    return null;
  }
});
