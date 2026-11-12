import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { LocalSetupStep } from '@renderer/features/switch-servers/AddServerModal';
import { localServerStore } from '@renderer/features/switch-servers/local-server-store';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { OnboardingSurface, useWizardExit } from '@renderer/lib/ui/wizard-frame';

/**
 * The first run's server on this computer, set up without asking: choosing
 * "On this computer" was the answer, so the server starts as the page opens
 * and the flow moves on by itself once it is up.
 *
 * What it says while it works is deliberately one line. The first run's
 * download steps (PostgreSQL, Mattermost's image) read as alarming detail to
 * someone who only wanted to try Switch.
 *
 * Anything that needs the person — a failed start, Docker missing for a server
 * that still runs on it, a status that could not be read — hands over to the
 * full setup page, which carries the error, Retry and Start over.
 */
export const LocalSetupProgress = observer(function LocalSetupProgress({
  onBack,
  onDone,
  onRegistered,
}: {
  onBack: () => void;
  onDone: (serverId: string | null) => void;
  onRegistered: (serverId: string) => void;
}) {
  const store = localServerStore;
  const exit = useWizardExit();
  const [ready, setReady] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    let live = true;
    void Promise.all([store.init(), store.checkDocker()]).then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, [store]);

  const running = store.isRunning;
  const transitioning = store.isTransitioning;
  const dockerReady = store.docker?.available ?? false;
  const canStart = store.runtime !== null && (store.runtime !== 'docker' || dockerReady);
  const blocked = store.phase === 'error' || store.error !== null || !canStart;

  useEffect(() => {
    if (!ready || attempted) return;
    if (running || transitioning) {
      setAttempted(true);
      return;
    }
    if (blocked) return;
    setAttempted(true);
    void store.start();
  }, [ready, attempted, running, transitioning, blocked, store]);

  const registeredId = store.status?.serverId ?? null;
  useEffect(() => {
    if (registeredId !== null) onRegistered(registeredId);
  }, [registeredId, onRegistered]);

  useEffect(() => {
    if (!running || done.current) return;
    done.current = true;
    onDone(store.status?.serverId ?? null);
  }, [running, onDone, store]);

  const needsPerson = ready && !running && !transitioning && (attempted || blocked);
  if (needsPerson) {
    return (
      <LocalSetupStep onBack={onBack} onDone={onDone} onClose={null} onRegistered={onRegistered} />
    );
  }

  return (
    <OnboardingSurface
      exit={exit}
      footer={
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-3 text-center" role="status">
        <Spinner className="size-6" />
        <h1 className="text-2xl font-semibold">Setting things up…</h1>
        <p className="text-sm text-foreground-muted">This might take a minute the first time.</p>
      </div>
    </OnboardingSurface>
  );
});
