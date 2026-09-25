import { ArrowUpCircle, Play, RefreshCw, TriangleAlert } from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import {
  type ManagedServerUpgrade,
  type SwitchVersionDrift,
  switchVersionDowngradeMessage,
} from '@shared/core/managed-switch-server/managed-switch-server';

const RESUME_NOTE = 'Sessions on this server resume once the update finishes.';

/**
 * Surfaces a managed stack whose switch-core version no longer matches the one
 * this build of Switch Console pins (CHOO-1736).
 *
 * A stack that is behind the pin is upgraded by Console on its own, so for that
 * case this is mostly a status rather than an offer: the update in progress,
 * the error it failed with (and a retry), or — for a stopped stack — that
 * starting it will update it. The exception is a running shared server others
 * have used lately, which is updated only when someone here says so, naming
 * who it reaches. Sessions on the server wait for it either way.
 *
 * The downgrade direction gets no action, only an explanation: the stack's
 * database has already migrated forward and switch-core cannot roll back, so
 * there is nothing safe for a button to do.
 */
export function VersionDriftNotice({
  drift,
  upgrade,
  progress,
  disabled,
  affected,
  onRestart,
}: {
  drift: SwitchVersionDrift | null;
  /** The upgrade the stack owes this build, if any. */
  upgrade: ManagedServerUpgrade | null;
  /** Who else an update of a shared server reaches, when anyone does. */
  affected: string | null;
  /** The current step of a start in flight ("Pulling images…"), or null. */
  progress: string | null;
  /** True while a lifecycle operation is in flight (or the host is unreachable). */
  disabled: boolean;
  /** Restart the stack; for an owed upgrade this is what runs it. */
  onRestart: () => void;
}) {
  if (upgrade) {
    return (
      <ServerUpgradeNotice
        upgrade={upgrade}
        progress={progress}
        disabled={disabled}
        affected={affected}
        onRetry={onRestart}
      />
    );
  }
  if (!drift) return null;

  // We could not read what is deployed. No action offered: restarting on the
  // strength of a failed probe could just as easily be a downgrade, and there
  // is nothing here to prove otherwise (CHOO-1865).
  if (drift.direction === 'unreadable') {
    return (
      <Alert variant="warning">
        <TriangleAlert className="size-4" />
        <AlertTitle>Can't tell which switch-core this is running</AlertTitle>
        <AlertDescription>
          {`This app expects ${drift.expected}, but the deployed version could not be read (${drift.reason}). Nothing is known about whether it matches.`}
        </AlertDescription>
      </Alert>
    );
  }

  if (drift.direction === 'downgrade') {
    return (
      <Alert variant="destructive">
        <TriangleAlert className="size-4" />
        <AlertTitle>This server is newer than Switch Console</AlertTitle>
        <AlertDescription>
          {switchVersionDowngradeMessage(drift.deployed, drift.expected)}
        </AlertDescription>
      </Alert>
    );
  }

  // Behind, but no update recorded yet: the check that starts it is still
  // running.
  if (drift.direction === 'upgrade') {
    return (
      <Alert variant="warning">
        <ArrowUpCircle className="size-4" />
        <AlertTitle>{`switch-core ${drift.expected} is required`}</AlertTitle>
        <AlertDescription>
          {`Still on switch-core ${drift.deployed}. Switch Console updates this server before running sessions on it. ${RESUME_NOTE}`}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="warning">
      <TriangleAlert className="size-4" />
      <AlertTitle>Version mismatch</AlertTitle>
      <AlertDescription>
        {`Runs switch-core ${drift.deployed}; this app expects ${drift.expected}. Can't tell which is newer — restart only if ${drift.expected} isn't older.`}
      </AlertDescription>
      <AlertAction>
        <Button size="sm" disabled={disabled} onClick={onRestart}>
          <RefreshCw className="size-4" />
          Restart to update
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** The state of an upgrade Console is running (or owes) for a managed stack. */
export function ServerUpgradeNotice({
  upgrade,
  progress,
  disabled,
  affected,
  onRetry,
}: {
  upgrade: ManagedServerUpgrade;
  progress: string | null;
  disabled: boolean;
  affected: string | null;
  onRetry: () => void;
}) {
  const versions = `switch-core ${upgrade.from} → ${upgrade.to}`;
  if (upgrade.state === 'updating') {
    return (
      <Alert role="status" aria-live="polite">
        <Spinner size="sm" />
        <AlertTitle>{`Updating ${versions}…`}</AlertTitle>
        <AlertDescription>
          <p>{`${RESUME_NOTE} Rooms and messages are kept, and the database is backed up before it is migrated.`}</p>
          {progress && <p className="text-foreground-muted">{progress}</p>}
        </AlertDescription>
      </Alert>
    );
  }
  if (upgrade.state === 'failed') {
    return (
      <Alert variant="destructive" role="alert">
        <TriangleAlert className="size-4" />
        <AlertTitle>{`Updating ${versions} failed`}</AlertTitle>
        <AlertDescription>
          <p className="break-words">{upgrade.error}</p>
          <p>Sessions on this server stay paused until the update succeeds.</p>
        </AlertDescription>
        <AlertAction>
          <Button size="sm" disabled={disabled} onClick={onRetry}>
            <RefreshCw className="size-4" />
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  if (upgrade.state === 'held') {
    return (
      <Alert variant="warning">
        <ArrowUpCircle className="size-4" />
        <AlertTitle>{`switch-core ${upgrade.to} is required`}</AlertTitle>
        <AlertDescription>
          <p>{`This server runs switch-core ${upgrade.from}. Others use it too, so Switch Console has not updated it on its own: updating restarts it for everyone. Its rooms, agents and data are kept, and the database is backed up first.`}</p>
          {affected && <p>{affected}</p>}
          <p>{RESUME_NOTE}</p>
        </AlertDescription>
        <AlertAction>
          <Button size="sm" disabled={disabled} onClick={onRetry}>
            <RefreshCw className="size-4" />
            Update for everyone
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  return (
    <Alert variant="warning">
      <ArrowUpCircle className="size-4" />
      <AlertTitle>{`switch-core ${upgrade.to} is required`}</AlertTitle>
      <AlertDescription>
        {`This server is stopped on switch-core ${upgrade.from}. Starting it updates it to ${upgrade.to} first. ${RESUME_NOTE}`}
      </AlertDescription>
      <AlertAction>
        <Button size="sm" disabled={disabled} onClick={onRetry}>
          <Play className="size-4" />
          Start and update
        </Button>
      </AlertAction>
    </Alert>
  );
}
