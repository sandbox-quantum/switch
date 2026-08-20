import { TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Spinner } from '@renderer/lib/ui/spinner';
import { Switch } from '@renderer/lib/ui/switch';
import { CHECKOUT_IMAGE_TAG } from '@shared/core/managed-switch-server/managed-switch-server';
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
  // Dev builds run from a Switch checkout only; null everywhere else.
  const checkout = store.checkoutBuild;
  const runsCheckoutBuild = store.status?.deployedVersion === CHECKOUT_IMAGE_TAG;
  // The toggle applies from the next start on, so say so while the containers
  // are still the ones the previous choice produced.
  const restartToApply =
    checkout !== null && store.isRunning && checkout.enabled !== runsCheckoutBuild;

  return (
    <StackSection>
      <StackStatusRow
        title="Local server"
        phase={store.phase}
        summary={store.isRunning ? 'Running on this computer' : phaseLabel(store.phase)}
        versionDetail={
          runsCheckoutBuild && checkout
            ? `switch-core built from ${checkout.root}`
            : runningVersion
              ? `switch-core ${runningVersion}`
              : null
        }
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
            <AlertTitle>{store.error}</AlertTitle>
            {store.errorDetail && <AlertDescription>{store.errorDetail}</AlertDescription>}
          </Alert>
        )}

        {/* Dev builds launched from a Switch checkout only — a released build
            never has a source tree to build from, so the row is absent rather
            than disabled. */}
        {checkout && (
          <div className="flex items-start justify-between gap-3 rounded-md border border-dashed border-border p-3">
            <div className="min-w-0">
              <p className="text-sm text-foreground">Build switch-core from this checkout</p>
              <p className="mt-0.5 text-xs text-foreground-muted">
                Dev builds only. Builds the switch, gateway and setup images from{' '}
                <span className="font-mono break-all">{checkout.root}</span> on every start, instead
                of pulling switch-core {store.status?.version}. They are tagged{' '}
                <span className="font-mono">{CHECKOUT_IMAGE_TAG}</span> so they can't be mistaken
                for a release.
                {restartToApply && ' Restart the server to apply.'}
              </p>
            </div>
            <Switch
              checked={checkout.enabled}
              disabled={transitioning}
              onCheckedChange={(enabled) => void store.setCheckoutBuild(enabled)}
              aria-label="Build switch-core from this checkout"
            />
          </div>
        )}

        {/* Behind the disclosure rather than shown the moment there is output:
            the log is what you go looking for, not what the section is for. */}
        {showActivity && store.logs.length > 0 && <LogTail lines={store.logs} placeholder={null} />}
      </div>
    </StackSection>
  );
});
