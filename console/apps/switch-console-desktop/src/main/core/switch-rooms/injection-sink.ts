import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import type { SessionControlAction } from './session-control';

/**
 * Who said what, and where, for a write that carries an addressed room message.
 *
 * The written text stays the full Switch envelope — it carries the ids the
 * agent answers with — so this is the same message taken apart, for a target
 * that can show a person the sender and the body rather than the envelope.
 */
export interface InjectedRoomMessage {
  sender: string;
  body: string;
  roomId: string;
  roomName: string | null;
  messageId: string;
}

/**
 * A live destination for injected prompt keystrokes. Locally this is the
 * agent's PTY (write goes straight to node-pty); on a remote VM the sidecar
 * implements this over `tmux send-keys` into the agent's tmux pane.
 */
export interface InjectionTarget {
  /**
   * `meta` accompanies an addressed room message. A terminal has nowhere to put
   * it and ignores it; a target with a transcript records it so the entry reads
   * as "who, in which room" instead of as the envelope.
   */
  write(data: string, meta?: InjectedRoomMessage): void;
  /**
   * Run a session-control step the target knows how to run itself, returning
   * whether it did. Only a target with a real runtime behind it implements
   * this; a terminal has nothing but keystrokes, so an unhandled step falls
   * back to the keystroke recipe.
   */
  control?(action: SessionControlAction): Promise<boolean>;
}

/**
 * Resolves the current injection target for a session, abstracting over the
 * transport. `acquire` returns null when the target is not ready to receive
 * input right now (e.g. the PTY is not live yet), in which case the caller
 * defers the injection and retries later.
 */
export interface InjectionSink {
  acquire(): InjectionTarget | null;
  /**
   * Whether the session is mid-turn and a room message should wait for the next
   * one. Separate from `acquire` because the two answer different questions:
   * `acquire` is "can this session be driven at all", which a control command
   * such as `!interrupt` needs to be true *precisely while* the session is
   * busy. Absent means never busy — a terminal takes what it is typed whenever
   * it is live.
   */
  isBusy?(): boolean;
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
