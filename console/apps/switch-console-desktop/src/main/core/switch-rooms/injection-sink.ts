import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';

/**
 * A live destination for injected prompt keystrokes. Locally this is the
 * agent's PTY (write goes straight to node-pty); on a remote VM the sidecar
 * implements this over `tmux send-keys` into the agent's tmux pane.
 */
export interface InjectionTarget {
  write(data: string): void;
}

/**
 * Resolves the current injection target for a session, abstracting over the
 * transport. `acquire` returns null when the target is not ready to receive
 * input right now (e.g. the PTY is not live yet), in which case the caller
 * defers the injection and retries later.
 */
export interface InjectionSink {
  acquire(): InjectionTarget | null;
}

/** Injects into a local PTY tracked by the in-process registry. */
export class PtyInjectionSink implements InjectionSink {
  constructor(private readonly ptyKey: string) {}

  acquire(): InjectionTarget | null {
    // A live pty is not the same as one ready to be typed into. A session
    // launched to answer a room message spends its first seconds booting its
    // TUI and then receiving its own opening prompt; the runtime says when
    // that is done. Writing before it means the message is swallowed by a TUI
    // that is not listening, or tacked onto the opening prompt.
    if (!ptySessionRegistry.isOpenForInjection(this.ptyKey)) return null;
    return ptySessionRegistry.get(this.ptyKey) ?? null;
  }
}
