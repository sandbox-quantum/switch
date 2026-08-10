import type { SessionRow } from '@main/db/schema';
import { noteAgentName, noteSessionTitle } from '@main/lib/log-name-cache';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { AgentStatus } from '@shared/core/providers/agentEvents';
import type { Session, SessionLifecycleStatus } from '@shared/core/sessions/sessions';

/**
 * Maps a session row to a `Session`. `providerId` and `agentName` are
 * denormalised from the owning agent and must be supplied by the caller (which
 * has joined `agents`). `agentName` is the agent's live `name` — the value a
 * definitions-capable provider launches as (`--agent <name>`) — read from the
 * agent row rather than frozen into the session, so it follows a rename.
 */
export function mapSessionRowToSession(
  row: SessionRow,
  providerId: AgentProviderId,
  agentName: string
): Session {
  // Single chokepoint for session rows, so the log sink can put a title next to
  // a session id without a query on the write path.
  noteSessionTitle(row.id, row.title);
  noteAgentName(row.agentId, agentName);

  const config = row.config ?? {};
  return {
    id: row.id,
    agentId: row.agentId,
    providerId,
    title: row.title,
    shellId: row.shellId,
    status: (row.status as SessionLifecycleStatus) ?? 'in_progress',
    statusChangedAt: row.statusChangedAt,
    agentSessionId: row.agentSessionId ?? null,
    agentStatus: (row.agentStatus as AgentStatus | null) ?? null,
    agentStatusSeen: row.agentStatusSeen === 1,
    isInitialSession: row.isInitialSession,
    isPinned: row.isPinned === 1,
    archivedAt: row.archivedAt ?? undefined,
    lastInteractedAt: row.lastInteractedAt ?? undefined,
    autoApprove: config.autoApprove,
    providerSessionId: config.providerSessionId,
    agentName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
