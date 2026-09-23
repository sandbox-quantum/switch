import { RefreshCw, TriangleAlert } from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import type { ManagedTelemetryNotice } from './managed-telemetry-notice';

/**
 * Surfaces a managed server still acting on an older answer to "Share usage
 * data" than the one the user has given (CHOO-2890).
 *
 * The server reads that answer when it starts, and nothing restarts it on the
 * user's behalf: a restart drops live agent sessions, which is not a price to
 * charge for a settings toggle without asking. So the gap is shown and the
 * restart offered, rather than either taken silently or left unsaid — an
 * opt-out that quietly does not reach the server is exactly the failure this
 * exists to prevent.
 */
export function TelemetryConsentNotice({
  notice,
  disabled,
  onRestart,
}: {
  notice: ManagedTelemetryNotice;
  /** True while a lifecycle operation is in flight (or the host is unreachable). */
  disabled: boolean;
  onRestart: () => void;
}) {
  if (notice.kind === 'in-step') return null;

  const { title, body } =
    notice.kind === 'unknown'
      ? {
          title: "Can't tell whether this server shares usage data",
          body: `Reading the setting off the server failed (${notice.reason}). Restarting applies your current choice, and makes it certain.`,
        }
      : notice.consent
        ? {
            title: 'This server is not sharing usage data yet',
            body: 'Your choice to share covers the servers Switch Console runs for you, but this one has been up since before you made it. Restart to apply it.',
          }
        : {
            title: 'This server is still sharing usage data',
            body: 'You turned sharing off. This server has been up since before that and keeps the setting it started with until it restarts. Restart to apply your choice.',
          };

  return (
    <Alert variant="warning">
      <TriangleAlert className="size-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{body}</AlertDescription>
      <AlertAction>
        <Button size="sm" disabled={disabled} onClick={onRestart}>
          <RefreshCw className="size-4" />
          Restart to apply
        </Button>
      </AlertAction>
    </Alert>
  );
}
