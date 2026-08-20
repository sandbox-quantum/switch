/**
 * How long a spawned session may go without reporting that it is up before
 * Switch Console treats it as stalled.
 *
 * Short on purpose: the notice exists so the person who asked stops waiting on
 * an answer that is not coming, and a notice that arrives a minute late has
 * already failed at that. The CLIs report as soon as their session exists,
 * before the first turn, so this is the gap between spawning a process and it
 * being ready to be spoken to — not the time to do any work.
 *
 * The cost of being wrong is asymmetric and mild in this direction: a slow
 * start that reports at five seconds gets one notice it did not need, and the
 * pane opens the moment the report lands either way. A stall never resolves
 * itself, so the only thing a longer wait buys is a later notice.
 */
export const STARTUP_SIGNAL_TIMEOUT_MS = 6_000;

export type StartupStall = {
  sessionId: string;
  providerId: string;
};

/**
 * The logging surface this needs, injected rather than imported so the watch
 * can run in the sidecar bundle — which must not pull in the Electron-bound
 * main-process file logger, and which is where a remote session's startup is
 * actually observed.
 */
export interface StartupWatchLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

type Watch = {
  sessionId: string;
  providerId: string;
  started: boolean;
  timer: ReturnType<typeof setTimeout>;
  settle: ((started: boolean) => void)[];
};

/**
 * Tracks whether a spawned session ever reported that it was really running.
 *
 * The gap this closes: a CLI that stops on a first-run prompt — workspace
 * trust, setup, a bypass warning — has spawned, is alive, and will never
 * answer. Nothing about the process says so, and the terminal cannot be asked
 * without pattern-matching the text of a security prompt, which fails silently
 * and wrongly the moment the wording changes. A hook the CLI fires when its
 * session comes up says it directly: it arrives when the session is running
 * and not at all when it is parked.
 *
 * Only for providers that declare `reportsSessionStart`. Everywhere else there
 * is no signal to wait on, and inventing one from terminal output is the thing
 * this exists to avoid.
 */
export class SessionStartupWatch {
  private readonly watches = new Map<string, Watch>();
  private readonly stallHandlers = new Set<(stall: StartupStall) => void>();

  constructor(
    private readonly timeoutMs: number,
    private readonly log: StartupWatchLogger
  ) {}

  /** Subscribe to sessions that never reported a start. Returns an unsubscribe. */
  onStall(handler: (stall: StartupStall) => void): () => void {
    this.stallHandlers.add(handler);
    return () => this.stallHandlers.delete(handler);
  }

  begin(args: { ptyId: string; sessionId: string; providerId: string }): void {
    this.end(args.ptyId);
    const timer = setTimeout(() => this.reportStall(args.ptyId), this.timeoutMs);
    // The wait outlives the timeout: a session that is merely slow still
    // reports eventually, and its pane should open when it does.
    timer.unref?.();
    this.watches.set(args.ptyId, {
      sessionId: args.sessionId,
      providerId: args.providerId,
      started: false,
      timer,
      settle: [],
    });
  }

  /**
   * A hook fired for this pty, so the CLI is past its startup prompts and
   * running. Any hook proves it, not only the session-start one.
   */
  markStarted(ptyId: string): void {
    const watch = this.watches.get(ptyId);
    if (!watch || watch.started) return;
    watch.started = true;
    clearTimeout(watch.timer);
    this.settleAll(watch, true);
  }

  /** The pty is gone; nothing is coming. */
  end(ptyId: string): void {
    const watch = this.watches.get(ptyId);
    if (!watch) return;
    this.watches.delete(ptyId);
    clearTimeout(watch.timer);
    this.settleAll(watch, watch.started);
  }

  /**
   * Resolves true once the session reports it is up, or false if the pty exits
   * first. Deliberately has no timeout of its own: a stall is worth reporting
   * but is not proof the session is dead, and typing into a pane that may still
   * be showing a security prompt is the failure this is here to prevent.
   */
  waitForStart(ptyId: string): Promise<boolean> {
    const watch = this.watches.get(ptyId);
    if (!watch) return Promise.resolve(false);
    if (watch.started) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => watch.settle.push(resolve));
  }

  /**
   * True when this pty is being watched and has not reported yet — the window
   * in which its pane may still be showing a startup prompt, so nothing should
   * be typed into it.
   *
   * A pty with no watch is not blocked. Only a spawn arms one, so an adopted or
   * already-running session must not be held mute waiting for a report that was
   * never expected of it.
   */
  blocksInjection(ptyId: string): boolean {
    const watch = this.watches.get(ptyId);
    return watch !== undefined && !watch.started;
  }

  private settleAll(watch: Watch, started: boolean): void {
    const waiters = watch.settle.splice(0);
    for (const resolve of waiters) resolve(started);
  }

  private reportStall(ptyId: string): void {
    const watch = this.watches.get(ptyId);
    if (!watch || watch.started) return;

    this.log.error('AgentRuntime: session never reported that it started', {
      event: 'switch_session_startup_stalled',
      sessionId: watch.sessionId,
      providerId: watch.providerId,
      waitedMs: this.timeoutMs,
    });

    const stall: StartupStall = { sessionId: watch.sessionId, providerId: watch.providerId };
    for (const handler of this.stallHandlers) {
      try {
        handler(stall);
      } catch (error) {
        this.log.warn('AgentRuntime: startup-stall handler failed', {
          sessionId: watch.sessionId,
          error: String(error),
        });
      }
    }
  }
}
