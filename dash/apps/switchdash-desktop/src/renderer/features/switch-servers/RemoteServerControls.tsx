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
import { remoteServerStore } from './remote-server-store';

const card = 'rounded-lg border border-border bg-card p-4';

/**
 * Lifecycle controls for a switchdash-managed Switch stack running on a remote
 * host: live status, Docker guidance, start / stop / reset — driven over the
 * host's SSH connection. Rendered inside the managed remote server's page.
 */
export const RemoteServerControls = observer(function RemoteServerControls({
  sshHost,
  serverId,
  name,
}: {
  sshHost: string;
  serverId: string;
  /** The registered server's name, reused when restarting so the record's name
   * is preserved (not blanked). */
  name: string;
}) {
  const store = remoteServerStore;
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    void store.init();
    void store.checkDocker(sshHost);
  }, [store, sshHost]);

  const status = store.statusFor(sshHost);
  const transitioning = store.isTransitioning(sshHost);
  const running = store.isRunning(sshHost);
  const docker = store.dockerFor(sshHost);
  const dockerUnavailable = docker && !docker.available ? docker : null;

  return (
    <div className={`${card} space-y-4`}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">Managed server</h3>
          <p className="text-xs text-foreground-muted">
            Runs the full Switch stack in Docker on {sshHost}, bridged to this computer over SSH.
          </p>
        </div>
        <PhaseBadge sshHost={sshHost} />
      </div>

      {status.message && transitioning && (
        <div className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner className="size-3.5" />
          <span>{status.message}</span>
        </div>
      )}

      {dockerUnavailable && (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" />
          <AlertTitle>
            {dockerUnavailable.reason === 'not-installed'
              ? 'Docker is not installed on the host'
              : 'Docker is not running on the host'}
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
        {running ? (
          <Button
            variant="outline"
            size="sm"
            disabled={transitioning}
            onClick={() => void store.stop(sshHost)}
          >
            <CircleStop className="size-4" />
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={transitioning}
            onClick={() => void store.start(sshHost, name)}
          >
            <Play className="size-4" />
            {status.phase === 'error' ? 'Retry' : 'Start'}
          </Button>
        )}
      </div>

      <p className="text-xs text-foreground-tertiary-passive">
        The stack keeps running on {sshHost} when you close switchdash. Remote-host agents stay
        connected; agents on this computer can reach it while switchdash is open.
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
        sshHost={sshHost}
        open={resetOpen}
        onOpenChange={setResetOpen}
        disabled={transitioning}
        onConfirm={() => {
          setResetOpen(false);
          void store.reset(sshHost, serverId);
        }}
      />
    </div>
  );
});

const ResetDialog = observer(function ResetDialog({
  sshHost,
  open,
  onOpenChange,
  disabled,
  onConfirm,
}: {
  sshHost: string;
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
          <DialogTitle>Reset server on {sshHost}</DialogTitle>
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

const PhaseBadge = observer(function PhaseBadge({ sshHost }: { sshHost: string }) {
  const phase = remoteServerStore.phaseFor(sshHost);
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
