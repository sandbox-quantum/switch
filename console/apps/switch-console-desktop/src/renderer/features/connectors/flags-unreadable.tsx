import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Alert, AlertAction, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import type { ServerFeatureFlags } from '@shared/core/feature-flags/feature-flags';

/**
 * What a page behind the `service_connections` flag shows when the server's
 * flags have never been read: why, rather than reading them as off and
 * sending the person elsewhere. Retry reads every server's flags again; the
 * page follows when they arrive.
 */
export function FlagsUnreadable({ flags }: { flags: ServerFeatureFlags | null }) {
  const [retrying, setRetrying] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const retry = async () => {
    setRetrying(true);
    setFailed(null);
    try {
      await rpc.featureFlags.refresh();
    } catch (cause) {
      setFailed(failureText(cause, "Couldn't read the server's settings again."));
    } finally {
      setRetrying(false);
    }
  };
  const reason = failed ?? flags?.error ?? null;
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {reason === null
          ? "Couldn't read whether this server has connectors turned on."
          : `Couldn't read whether this server has connectors turned on: ${reason}`}
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" disabled={retrying} onClick={() => void retry()}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );
}
