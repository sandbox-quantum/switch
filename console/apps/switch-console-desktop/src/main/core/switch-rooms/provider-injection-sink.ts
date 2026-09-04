import type { ProviderSessionRuntime } from '@main/core/agent-runtime/types';
import { log } from '@main/lib/logger';
import type { InjectionSink, InjectionTarget } from './injection-sink';
import type { PromptInjector } from './room-connection';
import type { SessionControlAction } from './session-control';

/**
 * Delivers a room message to a provider-backed session as a turn.
 *
 * The PTY sinks exist because a TUI has to be typed into — hence a readiness
 * gate, a bracketed-paste payload and a submit keystroke. None of that applies
 * here: `sendTurn` is a call, it is accepted or it throws, and a session that
 * is up is always ready for one. So `acquire` never defers, and the "write"
 * is the turn.
 *
 * `sendTurn` is asynchronous while `InjectionTarget.write` is not — deliberately
 * so, because `RoomConnection` treats a write as delivery and a rejection as a
 * reason to requeue, and awaiting a whole turn would mean requeueing on the
 * agent's answer rather than on its acceptance of the question. A send that is
 * refused is logged and surfaced in the transcript by the runtime.
 */
export class ProviderInjectionSink implements InjectionSink, InjectionTarget {
  constructor(
    private readonly sessionId: string,
    private readonly runtime: ProviderSessionRuntime,
    /** Say something in the session's transcript. Supplied by the runtime,
     *  which owns it; the sink only knows when a control step calls for one. */
    private readonly notice: (text: string) => void
  ) {}

  acquire(): InjectionTarget | null {
    return this;
  }

  /** The two control steps a runtime can run for itself. */
  async control(action: SessionControlAction): Promise<boolean> {
    if (action.kind === 'interrupt') {
      await this.runtime.interrupt();
      return true;
    }
    if (action.kind === 'notice') {
      this.notice(action.text);
      return true;
    }
    return false;
  }

  write(data: string): void {
    if (!data) return;
    void this.runtime.sendTurn(data, 'room').catch((error: unknown) => {
      log.error('ProviderInjectionSink: the session refused a room message', {
        event: 'provider_room_turn_refused',
        sessionId: this.sessionId,
        error: String(error),
      });
    });
  }
}

/**
 * The no-op counterpart to `PluginPromptInjector` for a session with no
 * terminal: the text goes over as it stands, and there is no Enter to press.
 *
 * The empty submit sequence is load-bearing — `RoomConnection` skips the second
 * write when there is nothing to send, which is what keeps a stray empty turn
 * out of the transcript after every room message.
 */
export class ProviderPromptInjector implements PromptInjector {
  build(text: string): { payload: string; submitSequence: string; submitDelayMs: number } {
    return { payload: text, submitSequence: '', submitDelayMs: 0 };
  }
}
