import { ArrowUpCircle, ShieldCheck, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { localServerStore } from './local-server-store';
import { LogTail } from './log-tail';
import { switchServersStore } from './switch-servers-store';

/** Stays in the workspace while the user navigates; never locks another server. */
export const LocalServerUpgradeNotice = observer(function LocalServerUpgradeNotice() {
  const [details, setDetails] = useState(false);
  const store = localServerStore;
  const status = store.status;
  if (!status?.upgrade || !status.serverId || switchServersStore.activeServerId !== status.serverId)
    return null;
  const working = status.upgrade !== 'required';
  const newer = status.drift?.direction === 'downgrade';
  const stopped = status.phase === 'stopped';
  const title =
    status.upgrade === 'checking'
      ? 'Checking your local server'
      : working
        ? 'Updating your local Switch server'
        : newer
          ? 'A newer Switch Console is needed'
          : stopped
            ? 'Your local server needs an update'
            : 'Let’s finish updating your local server';
  return (
    <section
      aria-label="Local server update"
      className="shrink-0 border-b border-border bg-background-secondary px-5 py-4"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-foreground-muted" aria-hidden="true">
          {working ? (
            <Spinner className="size-5" />
          ) : newer ? (
            <TriangleAlert className="size-5" />
          ) : (
            <ArrowUpCircle className="size-5" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p role="status" aria-live="polite" className="text-sm text-foreground-muted">
            {working
              ? status.message
              : newer
                ? 'This server was updated by a newer app. Update Switch Console to use it safely.'
                : stopped
                  ? 'It will update when you start it. Sessions will be available once the update finishes.'
                  : status.error?.startsWith('Open Docker') ||
                      status.error?.startsWith('Install Docker')
                    ? status.error
                    : 'Sessions on this server are paused until the update finishes. Check the details below, then retry.'}
          </p>
          {working && (
            <p className="flex items-center gap-1.5 text-xs text-foreground-muted">
              <ShieldCheck className="size-3.5" />
              Your rooms and agents stay in place. This may take a few minutes.
            </p>
          )}
          <button
            type="button"
            aria-expanded={details}
            onClick={() => setDetails(!details)}
            className="text-xs text-foreground-muted underline underline-offset-4 hover:text-foreground"
          >
            {details ? 'Hide details' : 'Show details'}
          </button>
        </div>
        {!working && !newer && (
          <Button size="sm" disabled={store.isTransitioning} onClick={() => void store.start()}>
            {stopped ? 'Update and start' : 'Retry update'}
          </Button>
        )}
      </div>
      {details && (
        <div className="mt-3 max-h-56 space-y-2 overflow-auto">
          {status.error && (
            <p role="alert" className="text-sm break-words text-foreground">
              {status.error}
            </p>
          )}
          <LogTail lines={store.logs} placeholder="Update activity will appear here." />
        </div>
      )}
    </section>
  );
});
