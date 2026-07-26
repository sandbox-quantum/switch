import z from 'zod';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { AgentStatus } from '@shared/core/providers/agentEvents';
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
 * A session: one instantiation/run of an agent (was switchdash's "conversation").
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
  /** Set when this session runs as a Claude Code subagent of its agent. */
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
