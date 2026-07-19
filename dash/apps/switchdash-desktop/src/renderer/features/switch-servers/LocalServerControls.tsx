import { CircleStop, Play, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { localServerStore } from './local-server-store';

const card = 'rounded-lg border border-border bg-card p-4';

/**
 * Lifecycle controls for the managed local Switch stack: live status, Docker
 * guidance, and start / stop / reset. Rendered inside the managed server's page.
 */
export const LocalServerControls = observer(function LocalServerControls() {
  const store = localServerStore;
  const [confirmingReset, setConfirmingReset] = useState(false);

  useEffect(() => {
    void store.checkDocker();
  }, [store]);

  const transitioning = store.isTransitioning;
  const dockerUnavailable = store.docker && !store.docker.available ? store.docker : null;

  return (
    <div className={`${card} space-y-4`}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">Local server</h3>
          <p className="text-xs text-foreground-muted">
            Runs the full Switch stack on this machine with Docker (switch-core{' '}
            {store.status?.version ?? ''}).
          </p>
        </div>
        <PhaseBadge />
      </div>

      {store.message && transitioning && (
        <div className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner className="size-3.5" />
          <span>{store.message}</span>
        </div>
      )}

      {dockerUnavailable && (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" />
          <AlertTitle>
            {dockerUnavailable.reason === 'not-installed'
              ? 'Docker is not installed'
              : 'Docker is not running'}
          </AlertTitle>
          <AlertDescription>{dockerUnavailable.detail}</AlertDescription>
        </Alert>
      )}

      {store.error && !dockerUnavailable && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{store.error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-2">
        {store.isRunning ? (
          <Button
            variant="outline"
            size="sm"
            disabled={transitioning}
            onClick={() => void store.stop()}
          >
            <CircleStop className="size-4" />
            Stop
          </Button>
        ) : (
          <Button size="sm" disabled={transitioning} onClick={() => void store.start()}>
            <Play className="size-4" />
            {store.phase === 'error' ? 'Retry' : 'Start'}
          </Button>
        )}

        {confirmingReset ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-foreground-muted">Delete all local data?</span>
            <Button
              variant="destructive"
              size="sm"
              disabled={transitioning}
              onClick={() => {
                setConfirmingReset(false);
                void store.reset();
              }}
            >
              Reset
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmingReset(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={transitioning}
            onClick={() => setConfirmingReset(true)}
          >
            Reset…
          </Button>
        )}
      </div>

      <p className="text-xs text-foreground-tertiary-passive">
        Reset stops the stack and permanently deletes its data (rooms, messages, agents). The stack
        keeps running when you close switchdash.
      </p>
    </div>
  );
});

const PhaseBadge = observer(function PhaseBadge() {
  const phase = localServerStore.phase;
  const label: Record<typeof phase, string> = {
    stopped: 'Stopped',
    starting: 'Starting',
    running: 'Running',
    stopping: 'Stopping',
    error: 'Error',
  };
  const dot: Record<typeof phase, string> = {
    stopped: 'bg-foreground-muted',
    starting: 'bg-amber-500',
    running: 'bg-green-500',
    stopping: 'bg-amber-500',
    error: 'bg-red-500',
  };
  return (
    <span className="flex items-center gap-1.5 text-xs text-foreground-muted">
      <span aria-hidden className={`inline-block size-2 rounded-full ${dot[phase]}`} />
      {label[phase]}
    </span>
  );
});
