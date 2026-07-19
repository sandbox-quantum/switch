import { type Session } from '@shared/core/sessions/sessions';

/**
 * Runtime handle for the single agent process of one session (one session =
 * one agent run). Implementations own the PTY, the respawn
 * supervisor, and — for SSH — the sidecar relay for that one agent.
 */
export interface AgentRuntimeProvider {
  start(
    session: Session,
    initialSize?: { cols: number; rows: number },
    isResuming?: boolean,
    initialPrompt?: string
  ): Promise<void>;
  /**
   * Close the local PTY view of the agent (the `dehydrateSession` RPC).
   * On tmux the agent keeps running and stays re-attachable; otherwise the
   * agent is gone and respawn tracking is cleared.
   */
  dehydrate(): Promise<void>;
  /**
   * Detach at session teardown: kill the local PTY but keep re-attach
   * bookkeeping (tmux pane, sidecar, reconnect listener) intact.
   */
  detach(): Promise<void>;
  /** Stop the agent for good: kill the PTY and tmux pane, disconnect the sidecar. */
  stop(): Promise<void>;
  /** Terminate teardown: stop everything and release agent-scoped listeners. */
  destroy(): Promise<void>;
}
