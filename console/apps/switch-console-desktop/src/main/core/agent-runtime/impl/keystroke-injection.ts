import { getPlugin } from '@main/core/providers/plugin-registry';
import type { Pty } from '@main/core/pty/pty';
import { log } from '@main/lib/logger';
import type { Session } from '@shared/core/sessions/sessions';
import { buildPromptInjectionPayload } from '@shared/prompt-injection';

// Inject only after the TUI has produced output and stayed idle for a beat;
// fixed delays race the agent's startup (auth, sync, model load).
const QUIET_PERIOD_MS = 800;
const MAX_WAIT_MS = 15_000;

/**
 * Wait for a session's TUI to settle, deliver its opening prompt if that prompt
 * is delivered by typing, and then declare the pane free for anything else.
 *
 * Two jobs, because they share one signal. Most providers take their opening
 * prompt on the command line (`argv`) rather than through the keyboard, so
 * there is nothing to type — but a room message still must not be typed into a
 * TUI that is mid-boot, and "the TUI has gone quiet" is the only readiness
 * signal there is. So the wait happens either way and only the injection is
 * conditional.
 */
export function scheduleInitialPromptInjection(args: {
  pty: Pty;
  session: Session;
  initialPrompt: string | undefined;
  isResuming: boolean;
  /**
   * Resolves true once the provider reports its session is really up, or false
   * if the pty exits first. Null for providers that cannot report it.
   *
   * "The TUI went quiet" cannot tell a ready pane from one parked on a
   * first-run trust or permission prompt — both stop producing output and wait
   * — so where a real signal exists it replaces the guess rather than racing
   * it. A session that never reports stays shut, which is the point: its pane
   * may be showing a security prompt whose default answer is "No, exit", and
   * typing a room message into that answers it.
   */
  awaitStartupSignal: (() => Promise<boolean>) | null;
  /**
   * Called once the pane is ready to be typed into and the session's own
   * opening prompt (if it had one to type) is in. Room messages wait on this:
   * delivered any earlier they land in a booting TUI, or in the middle of the
   * prompt being typed. Not called at all if the pty exits first.
   */
  onOpenForInjection: () => void;
}): void {
  const plugin = getPlugin(args.session.providerId);
  const promptDelivery = plugin.capabilities.prompt;
  // Only a keystroke provider has a prompt for us to type. Elsewhere it went
  // on the command line, or there is none, or the session is being resumed and
  // is picking up where it left off.
  const promptToType =
    !args.isResuming && args.initialPrompt?.trim() && promptDelivery.kind === 'keystroke'
      ? args.initialPrompt
      : null;

  let done = false;
  let sawAnyOutput = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  // Both must hold before anything is typed: the session has reported itself
  // up (or cannot report at all), and the pane has stopped painting.
  let startupReported = args.awaitStartupSignal === null;
  let settled = false;

  const open = (reason: string) => {
    log.info('AgentRuntime: session open for injected prompts', {
      event: 'switch_session_open_for_injection',
      providerId: args.session.providerId,
      sessionId: args.session.id,
      typedOpeningPrompt: promptToType !== null,
      reason,
    });
    args.onOpenForInjection();
  };

  const settle = () => {
    settled = true;
    if (startupReported) ready();
  };

  const ready = () => {
    if (done || !settled || !startupReported) return;
    done = true;
    if (quietTimer) clearTimeout(quietTimer);
    clearTimeout(maxWaitTimer);
    const reason = sawAnyOutput ? 'tui-quiet' : 'max-wait';

    if (promptToType === null) {
      open(reason);
      return;
    }

    const submitSequence =
      promptDelivery.kind === 'keystroke' ? (promptDelivery.submitSequence ?? '\r') : '\r';
    const submitDelayMs =
      promptDelivery.kind === 'keystroke' ? promptDelivery.submitDelayMs : undefined;
    const payload = buildPromptInjectionPayload(promptToType);

    try {
      if (submitDelayMs) {
        args.pty.write(payload);
        // Opened after the submit, not after the text: in between, the prompt
        // is sitting unsent in the composer and anything else typed would be
        // appended to it and sent as one.
        setTimeout(() => {
          args.pty.write(submitSequence);
          open(reason);
        }, submitDelayMs);
        return;
      }
      args.pty.write(`${payload}${submitSequence}`);
      open(reason);
    } catch (error) {
      log.warn('AgentRuntime: failed to inject initial prompt', {
        providerId: args.session.providerId,
        sessionId: args.session.id,
        error: String(error),
      });
      // The pane is no worse off for a write that failed, and holding the gate
      // shut would strand every room message for the life of the session.
      open('initial-prompt-failed');
    }
  };

  const maxWaitTimer = setTimeout(settle, MAX_WAIT_MS);

  if (args.awaitStartupSignal) {
    void args.awaitStartupSignal().then((reported) => {
      if (!reported) return;
      startupReported = true;
      ready();
    });
  }

  args.pty.onData(() => {
    if (done) return;
    sawAnyOutput = true;
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(settle, QUIET_PERIOD_MS);
  });

  args.pty.onExit(() => {
    const opened = done;
    done = true;
    if (quietTimer) clearTimeout(quietTimer);
    clearTimeout(maxWaitTimer);
    if (!opened && promptToType !== null) {
      log.warn('AgentRuntime: PTY exited before initial prompt could be injected', {
        providerId: args.session.providerId,
        sessionId: args.session.id,
        sawAnyOutput,
        startupReported,
      });
    }
  });
}
