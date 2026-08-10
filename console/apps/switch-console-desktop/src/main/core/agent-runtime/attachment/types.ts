import type { Session } from '@shared/core/sessions/sessions';

/** Whether a session's local PTY view of its remote agent is currently open. */
export type AttachState = 'detached' | 'attaching' | 'attached' | 'failed';

/** Why an attach was requested — for logs and for replay ordering. */
export type AttachReason = 'focus' | 'user' | 'startup' | 'adopt' | 'reconnect';

/**
 * The slice of a remote agent runtime the attachment pool drives.
 *
 * Kept deliberately narrow so the pool never imports `SshAgentRuntime` (which
 * pulls in the whole sidecar/pty stack) and so tests can drive it with a stub.
 * Only remote runtimes implement it: a local agent has no shared SSH transport
 * to protect, so `LocalAgentRuntime` never registers and stays uncapped.
 */
export interface AttachableRuntime {
  /** The pooled SSH connection this runtime shares, `agent-ssh:<host>`. The cap is per host. */
  readonly attachHostKey: string;
  readonly attachSessionId: string;

  /**
   * Bring up everything the session needs *except* the PTY: the on-VM sidecar
   * and its shared hook-event relay. Idempotent. Must be called before the
   * session can report status, room membership or notifications — those arrive
   * over the relay, not the terminal.
   */
  ensureAttachable(session: Session): Promise<void>;

  /** Open the local PTY onto the already-running remote tmux pane. */
  attach(): Promise<void>;

  /**
   * Close the local PTY only. The agent keeps running in its tmux pane and the
   * shared relay keeps reporting for it, so an evicted session is still live —
   * just not being watched.
   */
  detachForEviction(): Promise<void>;

  isAttached(): boolean;
}

/**
 * Whether a runtime participates in per-host attachment capping. False for
 * local runtimes, which have no shared SSH transport to protect.
 */
export function isAttachableRuntime(runtime: unknown): runtime is AttachableRuntime {
  const candidate = runtime as Partial<AttachableRuntime> | null;
  return (
    typeof candidate?.attachHostKey === 'string' &&
    typeof candidate.attachSessionId === 'string' &&
    typeof candidate.ensureAttachable === 'function' &&
    typeof candidate.attach === 'function' &&
    typeof candidate.detachForEviction === 'function' &&
    typeof candidate.isAttached === 'function'
  );
}
