import { useEffect, useRef } from 'react';

/** How often a template run still going on the server is read back. */
export const RUN_READ_BACK_MS = 3000;

/**
 * Call `tick` every `intervalMs` while `active`, one call at a time: the next
 * is scheduled only once the last has settled, so a slow read-back never
 * stacks up behind itself. The latest `tick` is the one called, so it may
 * close over state that changes between calls. Stops when `active` turns
 * false or the component unmounts.
 */
export function useWhileRunning(
  active: boolean,
  intervalMs: number,
  tick: () => Promise<void>
): void {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      timer = setTimeout(() => {
        void latest
          .current()
          .catch(() => {})
          .finally(() => {
            if (!stopped) schedule();
          });
      }, intervalMs);
    };
    schedule();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [active, intervalMs]);
}
