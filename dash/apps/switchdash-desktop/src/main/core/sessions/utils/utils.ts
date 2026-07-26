import type { SessionRow } from '@main/db/schema';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { AgentStatus } from '@shared/core/providers/agentEvents';
import type { Session, SessionLifecycleStatus } from '@shared/core/sessions/sessions';

/**
 * Maps a session row to a `Session`. `providerId` is denormalised from the
 * owning agent and must be supplied by the caller (which has joined `agents`).
 */
export function mapSessionRowToSession(row: SessionRow, providerId: AgentProviderId): Session {
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
    agentName: config.agentName ?? config.subagentName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
