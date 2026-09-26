import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { agentProviderLabel } from '@renderer/lib/components/agent-mark';
import { ChosenTile } from '@renderer/lib/components/chosen-tile';

/** The least an agent row or tile needs to draw itself. */
export type AgentPick = {
  id: string;
  name: string;
  iconUrl: string | null;
};

/**
 * What runs an agent, as this install knows it. The server's summary says what
 * type an agent is, not what provider drives it here; an agent registered from
 * another Switch Console has no local record and reads as a plain "Agent".
 */
export function agentProviderLabelFor(switchAgentId: string, workspaceId: string | null): string {
  const local =
    workspaceId === null
      ? null
      : (agentsStore
          .agentsInWorkspace(workspaceId)
          .find((a) => a.switchAgentId === switchAgentId) ?? null);
  return agentProviderLabel(local?.providerId);
}

/** One agent in a picker list: avatar, name, and what runs it. */
export function AgentPickerRow({ agent, subtitle }: { agent: AgentPick; subtitle: string }) {
  return (
    <>
      <AgentAvatar name={agent.name} iconUrl={agent.iconUrl} size={22} />
      <span className="min-w-0 flex-1 truncate">{agent.name}</span>
      <span className="shrink-0 text-xs text-foreground-muted">{subtitle}</span>
    </>
  );
}

/** An agent already chosen, with the way to take it back out. */
export function ChosenAgentTile({
  agent,
  subtitle,
  subtitleTone,
  onRemove,
}: {
  agent: AgentPick;
  subtitle: string;
  subtitleTone?: 'muted' | 'warning';
  onRemove: () => void;
}) {
  return (
    <ChosenTile
      mark={<AgentAvatar name={agent.name} iconUrl={agent.iconUrl} size={26} />}
      title={agent.name}
      subtitle={subtitle}
      subtitleTone={subtitleTone}
      onRemove={onRemove}
    />
  );
}
