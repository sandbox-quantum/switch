import { Circle, CircleCheck } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { LocalSetupStep } from '@renderer/features/switch-servers/AddServerModal';
import { localServerStore } from '@renderer/features/switch-servers/local-server-store';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { OnboardingSurface, useWizardExit } from '@renderer/lib/ui/wizard-frame';
import { SETUP_STAGES, setupStage } from './setup-stages';

/** How long the setup runs before the page says that a long one is expected. */
const LONG_SETUP_MS = 30_000;

/**
 * The first run's server on this computer, set up without asking: choosing
 * "On this computer" was the answer, so the server starts as the page opens
 * and the flow moves on by itself once it is up.
 *
 * What it says while it works is a short checklist of plain stages (see
 * {@link SETUP_STAGES}), not the steps themselves: the first run's downloads
 * and versions read as alarming detail to someone who only wanted to try Switch.
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
  // The furthest stage reached: a step the list does not know, or one that
  // repeats an earlier stage's work, never unticks one.
  const [stage, setStage] = useState(0);
  const [long, setLong] = useState(false);

  const reported = setupStage(store.message);
  useEffect(() => {
    if (reported !== null) setStage((reached) => Math.max(reached, reported));
  }, [reported]);

  useEffect(() => {
    const timer = setTimeout(() => setLong(true), LONG_SETUP_MS);
    return () => clearTimeout(timer);
  }, []);

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
      <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-2xl font-semibold">Setting things up…</h1>
        <ul
          className="flex flex-col gap-2.5 text-left"
          role="status"
          aria-label="Setting things up"
        >
          {SETUP_STAGES.map((label, index) => {
            const state = running || index < stage ? 'done' : index === stage ? 'current' : 'next';
            return (
              <li
                key={label}
                data-state={state}
                className={
                  state === 'next'
                    ? 'flex items-center gap-2.5 text-sm text-foreground-muted'
                    : 'flex items-center gap-2.5 text-sm text-foreground'
                }
              >
                {state === 'done' ? (
                  <CircleCheck aria-hidden className="size-4 text-green-500" />
                ) : state === 'current' ? (
                  <Spinner aria-hidden className="size-4" />
                ) : (
                  <Circle aria-hidden className="size-4" />
                )}
                {label}
              </li>
            );
          })}
        </ul>
        {long && (
          <p className="text-xs text-foreground-muted">
            Still working — the first setup can take a couple of minutes on a slow connection.
          </p>
        )}
      </div>
    </OnboardingSurface>
  );
});
