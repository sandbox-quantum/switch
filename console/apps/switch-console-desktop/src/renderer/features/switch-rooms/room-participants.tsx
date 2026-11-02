import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { cn } from '@renderer/utils/utils';
import { agentInitials } from '@shared/core/agents/agent-avatar';
import {
  knownAgentTypeDisplayName,
  providerDisplayName,
} from '@shared/core/providers/agent-provider-registry';
import type { RemoteAgentSummary } from '@shared/core/switch-servers/switch-servers';

/*
 * The pieces a room's members are drawn with, shared by the room's side panel
 * and its settings page.
 */

/** Query key for one room's own settings — shared so a save can write the
 * server's answer straight back into what the page is reading. */
export function roomDetailKey(workspaceId: string, roomId: string) {
  return ['remote-room-detail', workspaceId, roomId] as const;
}

/** A person's initials disc: people have no picture in Switch. */
export function PersonMark({ name, size }: { name: string; size: 'sm' | 'md' }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-[var(--fill-2)] font-medium text-foreground',
        size === 'md' ? 'size-7 text-xs' : 'size-[22px] text-[10px]'
      )}
    >
      {agentInitials(name)}
    </span>
  );
}

/** An agent's own picture, beside the human participants' initials discs. */
export function AgentMark({
  agentId,
  workspaceId,
  remoteById,
}: {
  agentId: string;
  workspaceId: string | null;
  remoteById: Map<string, RemoteAgentSummary>;
}) {
  const remote = remoteById.get(agentId) ?? null;
  return (
    <span className="flex size-7 shrink-0 items-center justify-center">
      <AgentAvatar
        name={agentNameFor(agentId, workspaceId, remoteById)}
        iconUrl={remote?.iconUrl ?? null}
        serverId={workspaceId && workspacesStore.serverIdFor(workspaceId)}
        size={26}
      />
    </span>
  );
}

/** This install's record of a Switch agent, which is where its provider is
 * known — the server says what type an agent is, not what runs it here. */
export function localAgentFor(switchAgentId: string, workspaceId: string | null) {
  if (workspaceId === null) return null;
  return (
    agentsStore.agentsInWorkspace(workspaceId).find((a) => a.switchAgentId === switchAgentId) ??
    null
  );
}

export function agentNameFor(
  switchAgentId: string,
  workspaceId: string | null,
  remoteById: Map<string, RemoteAgentSummary>
): string {
  return (
    localAgentFor(switchAgentId, workspaceId)?.name ??
    remoteById.get(switchAgentId)?.name ??
    'Agent'
  );
}

/** What an agent runs, in words: this install's provider when it has one,
 * otherwise the type the server knows it by. */
export function agentKindFor(
  switchAgentId: string,
  workspaceId: string | null,
  remoteById: Map<string, RemoteAgentSummary>
): string {
  const providerId = localAgentFor(switchAgentId, workspaceId)?.providerId ?? null;
  const knownType = remoteById.get(switchAgentId)?.knownAgentType ?? null;
  return providerDisplayName(providerId) ?? knownAgentTypeDisplayName(knownType) ?? 'agent';
}
