import { TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Spinner } from '@renderer/lib/ui/spinner';
import { localServerStore } from './local-server-store';
import { LogTail } from './log-tail';
import { phaseLabel, StackAction, StackSection, StackStatusRow } from './server-stack-section';

/**
 * Lifecycle for the managed local Switch stack: live status, Docker guidance,
 * and start / restart / stop. Rendered as its own section of the server's page;
 * resetting it lives at the bottom of that page rather than here.
 */
export const LocalServerControls = observer(function LocalServerControls() {
  const store = localServerStore;
  const [showActivity, setShowActivity] = useState(false);

  useEffect(() => {
    void store.checkDocker();
  }, [store]);

  const transitioning = store.isTransitioning;
  const dockerUnavailable = store.docker && !store.docker.available ? store.docker : null;
  // Report the version the stack is actually on, not the one this build wants —
  // they diverge exactly when the page's drift notice has something to say.
  const runningVersion = store.status?.deployedVersion ?? store.status?.version ?? '';
  // A stack ahead of this build must not be started at all: doing so would point
  // it at a core older than its database has migrated to (CHOO-1736).
  const downgradeBlocked = store.drift?.direction === 'downgrade';

  return (
    <StackSection>
      <StackStatusRow
        title="Local server"
        phase={store.phase}
        summary={store.isRunning ? 'Running on this computer' : phaseLabel(store.phase)}
        versionDetail={runningVersion ? `switch-core ${runningVersion}` : null}
        activity={
          store.logs.length > 0 ? (
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
          store.isRunning ? (
            <>
              <StackAction
                label="Restart"
                disabled={transitioning}
                onClick={() => void store.start()}
              />
              <StackAction
                label="Stop"
                danger
                disabled={transitioning}
                onClick={() => void store.stop()}
              />
            </>
          ) : (
            <StackAction
              label={store.phase === 'error' && !downgradeBlocked ? 'Retry' : 'Start'}
              disabled={transitioning || downgradeBlocked}
              onClick={() => void store.start()}
            />
          )
        }
      />

      <div className="space-y-3">
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

        {/* Behind the disclosure rather than shown the moment there is output:
            the log is what you go looking for, not what the section is for. */}
        {showActivity && store.logs.length > 0 && <LogTail lines={store.logs} placeholder={null} />}
      </div>
    </StackSection>
  );
});
