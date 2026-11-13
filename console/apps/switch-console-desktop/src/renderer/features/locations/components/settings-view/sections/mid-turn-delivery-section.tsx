import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Switch } from '@renderer/lib/ui/switch';
import { SettingRow } from './setting-row';

export const MID_TURN_TITLE = 'Steer messages sent while it works';
export const MID_TURN_DESCRIPTION =
  'A message sent while the agent is working reaches the running turn instead of waiting for it to end, whoever sent it and from wherever. The agent reads it at its next step: Claude Code after the tool call or answer in progress. Agents that cannot steer always queue. Off: messages from rooms wait for the turn to end.';

export function MidTurnDeliverySection({
  locationId,
  agentId,
}: {
  locationId: string;
  agentId?: string;
}) {
  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });
  return (
    <>
      {(agents ?? [])
        .filter((a) => a.workspaceId && a.switchAgentId && (!agentId || a.id === agentId))
        .map((a) => (
          <MidTurnDeliveryRow
            key={a.id}
            workspaceId={a.workspaceId as string}
            agentId={a.switchAgentId as string}
          />
        ))}
    </>
  );
}

export function MidTurnDeliveryRow({
  workspaceId,
  agentId,
}: {
  workspaceId: string;
  agentId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['remote-agents', workspaceId];
  const agents = useQuery({ queryKey, queryFn: () => rpc.workspaces.listAgents(workspaceId) });
  const agent = agents.data?.find((a) => a.id === agentId);
  const mutation = useMutation({
    mutationFn: (mode: 'steer' | 'queue') =>
      rpc.workspaces.updateMidTurnDelivery({ workspaceId, agentId, mode }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey }),
  });
  if (!agent || agent.midTurnDelivery === undefined) return null;
  return (
    <SettingRow
      title={MID_TURN_TITLE}
      info={null}
      description={MID_TURN_DESCRIPTION}
      control={
        <Switch
          aria-label={MID_TURN_TITLE}
          checked={agent.midTurnDelivery === 'steer'}
          disabled={mutation.isPending}
          onCheckedChange={(checked) => mutation.mutate(checked ? 'steer' : 'queue')}
        />
      }
    >
      {mutation.error && (
        <p role="alert">
          {failureText(mutation.error, 'Could not save the message delivery setting.')}
        </p>
      )}
    </SettingRow>
  );
}
