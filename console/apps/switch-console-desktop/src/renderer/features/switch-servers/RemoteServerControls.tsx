import { TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Spinner } from '@renderer/lib/ui/spinner';
import { LogTail } from './log-tail';
import { remoteServerStore } from './remote-server-store';
import { phaseLabel, StackAction, StackSection, StackStatusRow } from './server-stack-section';

/**
 * Lifecycle for a managed Switch stack running in Docker on an SSH host. The
 * same section as the local one, reading through per-host accessors; resetting
 * it lives at the bottom of the server's page rather than here.
 */
export const RemoteServerControls = observer(function RemoteServerControls({
  sshHost,
  name,
}: {
  sshHost: string;
  name: string;
}) {
  const store = remoteServerStore;
  const [showActivity, setShowActivity] = useState(false);

  useEffect(() => {
    void store.init();
    void store.checkDocker(sshHost);
  }, [store, sshHost]);

  const status = store.statusFor(sshHost);
  const hostBlocked = store.isHostBlocked(sshHost);
  // Every lifecycle action rides the host's SSH connection, so none of them can
  // succeed while it is down — disable rather than let them fail (CHOO-1780).
  const transitioning = store.isTransitioning(sshHost) || hostBlocked;
  const running = store.isRunning(sshHost);
  const docker = store.dockerFor(sshHost);
  const dockerUnavailable = docker && !docker.available ? docker : null;
  // Report the version the host is actually on, not the one this build wants —
  // they diverge exactly when the page's drift notice has something to say.
  const runningVersion = status.deployedVersion ?? status.version;
  // A stack ahead of this build must not be started at all: doing so would point
  // it at a core older than its database has migrated to (CHOO-1736).
  const downgradeBlocked = store.driftFor(sshHost)?.direction === 'downgrade';
  const logs = store.logsFor(sshHost);

  return (
    <StackSection>
      <StackStatusRow
        title={`Server on ${sshHost}`}
        phase={hostBlocked ? 'unreachable' : status.phase}
        summary={
          running ? `Running on ${sshHost}` : phaseLabel(hostBlocked ? 'unreachable' : status.phase)
        }
        versionDetail={runningVersion ? `switch-core ${runningVersion}` : null}
        activity={
          logs.length > 0 ? (
            <button
              type="button"
              onClick={() => setShowActivity((s) => !s)}
              className="text-foreground-muted underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {showActivity ? 'Hide activity' : 'Recent activity'}
            </button>
          ) : null
        }
        actions={
          running ? (
            <>
              <StackAction
                label="Restart"
                disabled={transitioning}
                onClick={() => void store.start(sshHost, name)}
              />
              <StackAction
                label="Stop"
                danger
                disabled={transitioning}
                onClick={() => void store.stop(sshHost)}
              />
            </>
          ) : (
            <StackAction
              label={status.phase === 'error' && !downgradeBlocked ? 'Retry' : 'Start'}
              disabled={transitioning || downgradeBlocked}
              onClick={() => void store.start(sshHost, name)}
            />
          )
        }
      />

      <div className="space-y-3">
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

        {/* Behind the disclosure rather than shown the moment there is output:
            the log is what you go looking for, not what the section is for. */}
        {showActivity && logs.length > 0 && <LogTail lines={logs} placeholder={null} />}
      </div>
    </StackSection>
  );
});
