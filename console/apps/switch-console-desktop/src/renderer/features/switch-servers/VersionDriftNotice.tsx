import { ArrowUpCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import {
  type SwitchVersionDrift,
  switchVersionDowngradeMessage,
} from '@shared/core/managed-switch-server/managed-switch-server';

/**
 * Surfaces a managed stack whose switch-core version no longer matches the one
 * this build of Switch Console pins (CHOO-1736).
 *
 * Updating the app moves the pin, but a stack that is already up is never
 * re-provisioned — without this the user silently keeps running the old core.
 * Restarting re-runs the start pipeline, which rewrites the `.env` at the new
 * pin and lets `compose up -d` recreate the changed containers.
 *
 * The downgrade direction gets no action, only an explanation: the stack's
 * database has already migrated forward and switch-core cannot roll back, so
 * there is nothing safe for a button to do.
 */
export function VersionDriftNotice({
  drift,
  disabled,
  onRestart,
}: {
  drift: SwitchVersionDrift | null;
  /** True while a lifecycle operation is in flight (or the host is unreachable). */
  disabled: boolean;
  onRestart: () => void;
}) {
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

  const unknown = drift.direction === 'unknown';
  return (
    <Alert variant="warning">
      {unknown ? <TriangleAlert className="size-4" /> : <ArrowUpCircle className="size-4" />}
      <AlertTitle>
        {unknown ? 'Version mismatch' : `switch-core ${drift.expected} is available`}
      </AlertTitle>
      <AlertDescription>
        {unknown
          ? `Runs switch-core ${drift.deployed}; this app expects ${drift.expected}. Can't tell which is newer — restart only if ${drift.expected} isn't older.`
          : `Still on switch-core ${drift.deployed}. Restart to pull ${drift.expected} and migrate; rooms and messages are kept.`}
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
