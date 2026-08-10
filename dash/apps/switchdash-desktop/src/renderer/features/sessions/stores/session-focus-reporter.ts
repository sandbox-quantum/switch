import { reaction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { log } from '@renderer/utils/logger';

/**
 * Debounce before reporting focus. Arrowing down the sidebar walks through
 * sessions the user is not stopping on; without this each one would ask a slow
 * remote host for a terminal and evict the last.
 */
const FOCUS_DEBOUNCE_MS = 150;

/**
 * Tell the main process which session the user is looking at.
 *
 * Remote terminals are capped per host, so the pool needs to know what to keep
 * attached and what may be evicted. The renderer is the only place that knows,
 * and this is the whole of what it tells it: one session id, or null when the
 * user is elsewhere.
 */
export function startSessionFocusReporter(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastReported: string | null = null;

  const report = (sessionId: string | null) => {
    if (sessionId === lastReported) return;
    lastReported = sessionId;
    void rpc.sessions.focusSession(sessionId).catch((error: unknown) => {
      log.warn('SessionFocusReporter: failed to report focused session', { sessionId, error });
    });
  };

  const dispose = reaction(
    () => {
      const navigation = appState.navigation;
      if (navigation.currentViewId !== 'session') return null;
      return navigation.viewParamsStore.session?.sessionId ?? null;
    },
    (sessionId) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        report(sessionId);
      }, FOCUS_DEBOUNCE_MS);
    },
    { fireImmediately: true }
  );

  return () => {
    if (timer) clearTimeout(timer);
    dispose();
  };
}
