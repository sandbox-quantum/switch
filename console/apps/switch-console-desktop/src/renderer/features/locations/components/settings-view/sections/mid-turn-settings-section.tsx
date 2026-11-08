import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { Switch } from '@renderer/lib/ui/switch';
import { log } from '@renderer/utils/logger';
import type { Agent } from '@shared/core/agents/agents';
import { SettingRow } from './setting-row';

/** What the steering row says, wherever it is shown. */
export const MID_TURN_COPY = {
  title: 'Steer with mid-turn messages',
  description: 'A message sent while the agent works joins the running turn. Off, it waits.',
  infoLabel: 'More info about steering',
  info: 'A message in the same thread, from whoever started the turn or from you, is delivered into the turn the agent is running, so it can change course. Anyone else, and any other thread, waits for a turn of its own. Claude, Codex and OpenCode can steer; with other providers messages always wait.',
} as const;

/**
 * Per-agent choice between steering the running turn with a message sent
 * mid-turn and always queueing it. On by default. The value lives on the
 * agent row and is read as each session starts; `setAgentMidTurnMessages`
 * hands it to a running watcher.
 */
export function MidTurnSettingsSection({
  locationId,
  agentId,
}: {
  locationId: string;
  /** Scope to a single agent; omit for every agent. */
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
      title={MID_TURN_COPY.title}
      info={{ label: MID_TURN_COPY.infoLabel, content: MID_TURN_COPY.info }}
      description={MID_TURN_COPY.description}
      control={single && <MidTurnSwitch agent={single} locationId={locationId} />}
    >
      {!single && (
        <div className="flex flex-col gap-2">
          {list.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-2 py-1.5"
            >
              <span className="truncate text-sm">{agent.name}</span>
              <MidTurnSwitch agent={agent} locationId={locationId} />
            </div>
          ))}
        </div>
      )}
    </SettingRow>
  );
}

function MidTurnSwitch({ agent, locationId }: { agent: Agent; locationId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ['location-agents', locationId];
  const mutation = useMutation({
    mutationFn: (steer: boolean) =>
      rpc.agents.setMidTurnMessages({
        agentId: agent.id,
        midTurnMessages: steer ? 'steer' : 'queue',
      }),
    onError: (error) =>
      log.error('Failed to update how mid-turn messages are delivered', {
        agentId: agent.id,
        error,
      }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey }),
  });

  return (
    <Switch
      aria-label={MID_TURN_COPY.title}
      checked={agent.midTurnMessages === 'steer'}
      disabled={mutation.isPending}
      onCheckedChange={(checked) => mutation.mutate(checked)}
    />
  );
}
