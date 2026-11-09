import { BACKGROUND_EVENTS, type TelemetryEventName } from './events';

/** How long without anything someone did before the next thing they do starts a new session. */
export const SESSION_IDLE_MS = 30 * 60_000;

/** The session a background event carries: Amplitude reads -1 as none. */
export const NO_SESSION = -1;

/**
 * Amplitude's session, as this app reports it: a run of things someone did in
 * the app, with no gap between two of them longer than {@link SESSION_IDLE_MS}.
 * Its id is the time the first of them happened, in epoch milliseconds, which
 * is what Amplitude expects of a session id and says nothing an event's own
 * timestamp does not.
 *
 * Only an event someone caused starts a session or keeps one going. One that is
 * not someone using the app is in no session at all, so a session's length is
 * time someone spent in the app rather than time it was left open: an event
 * whose every occurrence is the app's own (`BACKGROUND_EVENTS`), or one
 * occurrence the caller says nobody caused (`background`), such as a session
 * that ended because a pass removed its agent.
 *
 * Kept in memory: a launch starts afresh with the first thing someone does.
 */
export class TelemetrySession {
  private startedAt: number | null = null;
  private lastActivityAt = Number.NEGATIVE_INFINITY;

  /** The session an event at `timeMs` belongs to, starting one if it is due. */
  idFor(name: TelemetryEventName, timeMs: number, background: boolean): number {
    if (background || BACKGROUND_EVENTS.has(name)) return NO_SESSION;
    if (this.startedAt === null || timeMs - this.lastActivityAt > SESSION_IDLE_MS) {
      this.startedAt = timeMs;
    }
    // A report that arrives late carries the time it happened, which must not
    // pull the session's last activity back.
    this.lastActivityAt = Math.max(this.lastActivityAt, timeMs);
    return this.startedAt;
  }
}
