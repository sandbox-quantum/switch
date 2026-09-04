import type { ApprovalDecision, UserInputAnswers } from '@switch-console/agent-providers';
import type {
  SessionTranscript,
  TranscriptDecidedBy,
  TranscriptRoomOrigin,
  TranscriptUpdate,
  TranscriptUserSource,
} from '@shared/core/sessions/session-transcript';
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

/**
 * The extra surface a session driven through a provider adapter offers, on top
 * of the lifecycle every runtime has.
 *
 * A PTY session is spoken to by writing bytes at a terminal and read by
 * scraping it; there is nothing else to call. A provider session has a real
 * protocol underneath — turns, approvals, questions — so everything that would
 * otherwise be a keystroke recipe is a method here, and everything that would
 * be terminal output is a transcript.
 */
export interface ProviderSessionRuntime {
  /**
   * Send a user turn. `source` labels who it came from so the transcript can
   * tell a message typed in the console from one relayed out of a Switch room.
   *
   * `room` accompanies a room message: `text` stays the Switch envelope the
   * agent needs, and this is what the transcript shows in its place.
   */
  sendTurn(
    text: string,
    source: TranscriptUserSource,
    room?: TranscriptRoomOrigin & { body: string }
  ): Promise<{ turnId: string }>;
  /**
   * Whether a turn is in flight. A caller that has a choice about when to
   * speak — the room, which can hold a message — asks first, because a turn
   * sent now joins the running one instead of starting its own.
   */
  isTurnRunning(): boolean;
  /** Stop the running turn, if there is one. */
  interrupt(): Promise<void>;
  /** `decidedBy` is recorded on the request so the card says where the answer
   *  came from — the console's own buttons, or a reply in the room. */
  respondToRequest(
    requestId: string,
    decision: ApprovalDecision,
    decidedBy: TranscriptDecidedBy
  ): Promise<void>;
  respondToUserInput(requestId: string, answers: UserInputAnswers): Promise<void>;
  /** Record a line the app itself has to say, not the agent — a control command
   *  that only half applies, a degraded mode. */
  notice(level: 'info' | 'warning' | 'error', text: string): void;
  /** The whole transcript, for a renderer that has just attached. */
  getTranscript(): SessionTranscript;
  /** Incremental updates from now on. Returns the unsubscribe. */
  subscribe(listener: (update: TranscriptUpdate) => void): () => void;
}

/**
 * Whether a runtime is provider-backed, and therefore answers the methods
 * above. Everything that branches on the runtime kind at the call site goes
 * through this rather than reading the session row again.
 */
export function isProviderRuntime(
  runtime: unknown
): runtime is AgentRuntimeProvider & ProviderSessionRuntime {
  if (runtime === null || typeof runtime !== 'object') return false;
  const candidate = runtime as Partial<ProviderSessionRuntime>;
  return typeof candidate.sendTurn === 'function' && typeof candidate.getTranscript === 'function';
}
