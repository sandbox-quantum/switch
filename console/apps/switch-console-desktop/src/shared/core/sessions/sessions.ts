import z from 'zod';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { AgentStatus } from '@shared/core/providers/agentEvents';
import type { SessionStartSource, UiEntryPoint } from '@shared/core/telemetry/reporting';
import type { TerminalShellId } from '@shared/core/terminals/terminal-settings';

export const MAX_SESSION_TITLE_LENGTH = 100;

export const sessionLifecycleStatuses = z.enum([
  'todo',
  'in_progress',
  'review',
  'done',
  'cancelled',
  'backlog',
  'duplicate',
  'triage',
]);

export type SessionLifecycleStatus = z.infer<typeof sessionLifecycleStatuses>;

/**
 * A session: one instantiation/run of an agent (was Switch Console's "conversation").
 * It belongs to an agent (which carries the location + provider), and is 1:1
 * with the terminal it runs in (`shellId`). `providerId` is denormalised from
 * the owning agent for rendering.
 */
export type Session = {
  id: string;
  agentId: string;
  providerId: AgentProviderId;
  title: string;
  shellId: TerminalShellId;
  status: SessionLifecycleStatus;
  /** ISO timestamp: when lifecycle status last changed (current status entered). */
  statusChangedAt: string;
  /** Provider-native session id captured at runtime for resume. */
  agentSessionId: string | null;
  /**
   * Provider-native chat id stored in the session's `config` JSON (e.g. the
   * Codex rollout / Droid UUID) used to resume the correct chat. Distinct from
   * `agentSessionId`, which is the `agent_session_id` column.
   */
  providerSessionId?: string;
  agentStatus?: AgentStatus | null;
  agentStatusSeen?: boolean;
  isInitialSession: boolean | null;
  isPinned: boolean;
  archivedAt?: string;
  lastInteractedAt?: string;
  autoApprove?: boolean;
  /** The session's agent's name, read live from the agent row on every load
   *  (so it follows a rename). Absent only for a row that predates named agents. */
  agentName?: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionBootstrapStatus =
  | { status: 'ready' }
  | { status: 'bootstrapping' }
  | { status: 'error'; message: string }
  | { status: 'not-started' };

export type CreateSessionParams = {
  id: string;
  agentId: string;
  title: string;
  shellId?: TerminalShellId;
  autoApprove?: boolean;
  initialPrompt?: string;
  initialSize?: { cols: number; rows: number };
  /**
   * Run this session as a Claude Code subagent of `agentId`: launches the CLI
   * with `--agent <agentName>` and the subagent's own Switch credentials, so
   * it joins rooms under the subagent's identity. The session is still owned by
   * the parent `agentId` (it runs in the parent's working directory).
   */
  agentName?: string;
  /**
   * Open a terminal for the new session. Defaults to true.
   *
   * Pass false when the agent is already running and the row is only catching
   * up with it — the remote session reconciler adopting a session the VM
   * started on its own. Such a session is made attachable (sidecar + hook-event
   * relay) but gets no PTY until someone views it.
   */
  attach?: boolean;
  /**
   * Which control the user started the session from, for reporting. Omitted by
   * callers with no user behind them, which report as `unknown`.
   */
  entryPoint?: UiEntryPoint;
  /**
   * Who started the session: a person, the app on their behalf, or a remote host
   * that was already running one. Omitted reports as `unknown` rather than
   * assuming a person was there.
   */
  startSource?: SessionStartSource;
  /**
   * Whether a Switch room was chosen for this session before it was created,
   * for reporting. Never which room.
   *
   * Declared by the caller rather than read back, because the record that would
   * answer it is consumed during the launch this session is part of: the
   * poller's intended-room entry is claimed by `ensureForSession` while
   * `createSession` is still running, so anything asking afterwards is told no.
   */
  connectedToRoom?: boolean;
};

export type CreateSessionError =
  | { type: 'agent-not-found' }
  | { type: 'already-exists' }
  | { type: 'spawn-failed'; message: string };

export type CreateSessionSuccess = {
  session: Session;
};

export type RenameSessionParams = {
  sessionId: string;
  newTitle: string;
};

export type RenameSessionError = { type: 'session-not-found'; sessionId: string };

export type RenameSessionSuccess = {
  session: Session;
};
