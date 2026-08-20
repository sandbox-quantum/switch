import { log } from '@main/lib/logger';
import { SessionStartupWatch, STARTUP_SIGNAL_TIMEOUT_MS } from './session-startup-watch';

/**
 * The watch over sessions this desktop spawned itself.
 *
 * Separate from the class so the sidecar can import the class without this
 * module's Electron-bound logger coming with it. A remote session is watched by
 * the sidecar that spawned it, on its own instance — the two processes see
 * different sessions and neither should be told about the other's.
 */
export const sessionStartupWatch = new SessionStartupWatch(STARTUP_SIGNAL_TIMEOUT_MS, log);
