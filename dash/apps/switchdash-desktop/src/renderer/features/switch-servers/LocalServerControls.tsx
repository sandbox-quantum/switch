import { CircleStop, Play, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogContentArea,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';
import { localServerStore } from './local-server-store';
import { VersionDriftNotice } from './VersionDriftNotice';

const card = 'rounded-lg border border-border bg-card p-4';

/**
 * Lifecycle controls for the managed local Switch stack: live status, Docker
 * guidance, and start / stop / reset. Rendered inside the managed server's page.
 */
export const LocalServerControls = observer(function LocalServerControls() {
  const store = localServerStore;
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    void store.checkDocker();
  }, [store]);

  const transitioning = store.isTransitioning;
  const dockerUnavailable = store.docker && !store.docker.available ? store.docker : null;
  const drift = store.drift;
  // Report the version the stack is actually on, not the one this build wants —
  // they diverge exactly when the drift notice below has something to say.
  const runningVersion = store.status?.deployedVersion ?? store.status?.version ?? '';
  // A stack ahead of this build must not be started at all: doing so would point
  // it at a core older than its database has migrated to (CHOO-1736).
  const downgradeBlocked = drift?.direction === 'downgrade';

  return (
    <div className={`${card} space-y-4`}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">Managed server</h3>
          <p className="text-xs text-foreground-muted">
            Runs the full Switch stack on this computer with Docker (switch-core {runningVersion}).
          </p>
        </div>
        <PhaseBadge />
      </div>

      <VersionDriftNotice
        drift={drift}
        disabled={transitioning}
        onRestart={() => void store.start()}
      />

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
          <Button
            size="sm"
            disabled={transitioning || downgradeBlocked}
            onClick={() => void store.start()}
          >
            <Play className="size-4" />
            {store.phase === 'error' && !downgradeBlocked ? 'Retry' : 'Start'}
          </Button>
        )}
      </div>

      <p className="text-xs text-foreground-tertiary-passive">
        The stack keeps running when you close switchdash.
      </p>

      <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-4">
        <div className="space-y-0.5">
          <p className="text-xs font-medium text-foreground">Reset</p>
          <p className="text-xs text-foreground-tertiary-passive">
            Permanently deletes the stack's data and every agent configured against it.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={transitioning}
          className="shrink-0 border-red-500/40 text-red-500 hover:bg-red-500/10 hover:text-red-500"
          onClick={() => setResetOpen(true)}
        >
          Reset…
        </Button>
      </div>

      <ResetDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        disabled={transitioning}
        onConfirm={() => {
          setResetOpen(false);
          void store.reset();
        }}
      />
    </div>
  );
});

const ResetDialog = observer(function ResetDialog({
  open,
  onOpenChange,
  disabled,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <TriangleAlert className="size-4 text-red-500" />
          <DialogTitle>Reset server on this computer</DialogTitle>
        </DialogHeader>
        <DialogContentArea>
          <DialogDescription>
            This permanently deletes this managed server and everything on it — all rooms, messages,
            and{' '}
            <strong className="text-foreground">every agent you've configured against it</strong>.
            This can't be undone. A fresh Start rebuilds an empty stack from scratch.
          </DialogDescription>
        </DialogContentArea>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button variant="destructive" size="sm" disabled={disabled} onClick={onConfirm}>
            Reset and delete all agents
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
