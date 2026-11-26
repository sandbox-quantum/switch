import { MidTurnDeliverySetting } from '@switch-console/chat-ui/components/agent-permissions';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';

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
    <MidTurnDeliverySetting
      steer={agent.midTurnDelivery === 'steer'}
      disabled={mutation.isPending}
      onChange={(mode) => mutation.mutate(mode)}
      error={
        mutation.error
          ? failureText(mutation.error, 'Could not save the message delivery setting.')
          : null
      }
    />
  );
}
