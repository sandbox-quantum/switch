import type { Session } from '@shared/core/sessions/sessions';

export interface AgentRuntimeProvider {
  restart(session: Session): Promise<void>;
  start(
    session: Session,
    initialSize?: { cols: number; rows: number },
    isResuming?: boolean,
    initialPrompt?: string
  ): Promise<void>;
  /**
   * Release the Console view while execution continues on the host.
   */
  dehydrate(): Promise<void>;
  /**
   * Release this client while retaining persistent host execution.
   */
  detach(): Promise<void>;
  /** Deliver a server-authorized permanent session stop. */
  stop(): Promise<void>;
  /** Terminate teardown: stop everything and release agent-scoped listeners. */
  destroy(): Promise<void>;
}
