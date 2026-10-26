type FocusTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** How often a page waiting on Docker asks again for one that wasn't answering. */
export const DOCKER_RECHECK_MS = 3000;

/**
 * Asks for Docker again until stopped: `everyMs` after each check finishes, and
 * at once when the window regains focus. A check can take seconds while Docker
 * boots, so checks never overlap, and none is scheduled after stopping.
 * Returns the function that stops it.
 */
export function recheckDocker(check: () => Promise<void>, target: FocusTarget, everyMs: number) {
  let stopped = false;
  let checking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (stopped || checking) return;
    checking = true;
    clearTimeout(timer);
    void check().finally(() => {
      checking = false;
      if (!stopped) timer = setTimeout(run, everyMs);
    });
  };
  timer = setTimeout(run, everyMs);
  target.addEventListener('focus', run);
  return () => {
    stopped = true;
    clearTimeout(timer);
    target.removeEventListener('focus', run);
  };
}
