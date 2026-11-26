import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { CanManageAgentsSetting } from '@switch-console/chat-ui/components/agent-permissions';

/**
 * Per-Switch-agent "can manage agents" capability: with it on, the agent may
 * list its owner's machines and managed agents and create managed agents on
 * those machines, acting for the owner. Shown only for Switch-linked agents on
 * a server that runs agent management, since it does nothing anywhere else.
 * The value lives on the server; only the agent's owner may change it.
 */
export function CanManageAgentsSettingsSection({
  locationId,
  agentId,
}: {
  locationId: string;
  /** Scope to a single agent; omit to show every Switch-linked agent. */
  agentId?: string;
}) {
  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });

  const switchAgents = (agents ?? []).filter(
    (a) => a.workspaceId && a.switchAgentId && (!agentId || a.id === agentId)
  );
  if (switchAgents.length === 0) return null;

  return (
    <>
      {switchAgents.map((agent) => (
        <CanManageAgentsRow
          key={agent.id}
          workspaceId={agent.workspaceId as string}
          agentId={agent.switchAgentId as string}
          agentName={switchAgents.length > 1 ? agent.name : null}
        />
      ))}
    </>
  );
}

export function CanManageAgentsRow({
  workspaceId,
  agentId,
  agentName,
}: {
  workspaceId: string;
  agentId: string;
  /** Shown when the location has several Switch agents; null for one. */
  agentName: string | null;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['agent-management-access', workspaceId, agentId];
  const { data: access } = useQuery({
    queryKey,
    queryFn: () => rpc.workspaces.getAgentManagementAccess({ workspaceId, agentId }),
  });
  const mutation = useMutation({
    mutationFn: (enabled: boolean) =>
      rpc.workspaces.updateCanManageAgents({ workspaceId, agentId, enabled }),
    onError: (error) => log.error('Failed to update "can manage agents"', { agentId, error }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey }),
  });

  if (!access?.available) return null;

  return (
    <CanManageAgentsSetting
      agentName={agentName}
      machineWord="machine"
      checked={access.canManageAgents}
      disabled={mutation.isPending}
      onChange={(checked) => mutation.mutate(checked)}
      error={
        mutation.error
          ? failureText(mutation.error, 'Could not change whether this agent can manage agents.')
          : null
      }
    />
  );
}
