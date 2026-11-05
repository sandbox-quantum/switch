import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { Switch } from '@renderer/lib/ui/switch';
import { log } from '@renderer/utils/logger';
import type { Agent } from '@shared/core/agents/agents';
import { SettingRow } from './setting-row';

/** What the steering row says. */
export const MESSAGE_DELIVERY_COPY = {
  title: 'Steer messages sent while working',
  on: 'A correction sent while the agent works reaches it at once. Turn off to always queue.',
  off: 'Messages sent while the agent works wait for the current turn to end.',
  infoLabel: 'More info about steering messages',
  info: 'On Claude Code, Codex and OpenCode, a message from the conversation the agent is working in joins the running turn, so "no, use the other file" lands while it still matters. Only the person who started that turn or the agent\'s owner steers it; messages from anyone else, or from another thread or room, queue. Antigravity and Cursor always queue. Applies from the agent\'s next session.',
} as const;

/**
 * Per-agent choice between steering a message sent mid-turn into the running
 * turn and always queueing it. The value lives on the agent row and is read
 * when a session starts.
 */
export function MessageDeliverySettingsSection({
  locationId,
  agentId,
}: {
  locationId: string;
  /** Scope to a single agent (e.g. a subagent's own row); omit for every agent. */
  agentId?: string;
}) {
  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });

  const list = (agents ?? []).filter((a) => !agentId || a.id === agentId);
  if (list.length === 0) return null;
  const single = list.length === 1 ? list[0] : null;

  return (
    <SettingRow
      title={MESSAGE_DELIVERY_COPY.title}
      info={{ label: MESSAGE_DELIVERY_COPY.infoLabel, content: MESSAGE_DELIVERY_COPY.info }}
      description={
        single && !single.steerMessages ? MESSAGE_DELIVERY_COPY.off : MESSAGE_DELIVERY_COPY.on
      }
      control={single && <SteeringSwitch agent={single} locationId={locationId} />}
    >
      {!single && (
        <div className="flex flex-col gap-2">
          {list.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-2 py-1.5"
            >
              <span className="truncate text-sm">{agent.name}</span>
              <SteeringSwitch agent={agent} locationId={locationId} />
            </div>
          ))}
        </div>
      )}
    </SettingRow>
  );
}

function SteeringSwitch({ agent, locationId }: { agent: Agent; locationId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ['location-agents', locationId];

  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      rpc.agents.setAgentSteering({ agentId: agent.id, enabled: next }),
    onError: (error) => {
      log.error('Failed to update the steering setting for agent', {
        agentId: agent.id,
        error,
      });
      void queryClient.invalidateQueries({ queryKey });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  return (
    <Switch
      aria-label={MESSAGE_DELIVERY_COPY.title}
      checked={agent.steerMessages}
      disabled={mutation.isPending}
      onCheckedChange={(checked) => mutation.mutate(checked)}
    />
  );
}
