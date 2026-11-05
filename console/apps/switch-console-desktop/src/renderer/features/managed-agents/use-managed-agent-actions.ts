import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useCloudMachines } from '@renderer/features/cloud-agents/use-cloud-agents';
import { useAnsweredFlags } from '@renderer/features/switch-buddy/use-this-computer';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { confirmedWithdraw, deleteDescription } from './delete-description';
import { managedAgentLabel } from './managed-agent-state';
import { MANAGED_AGENTS_KEY, useManagedAgents } from './use-managed-agents';

/** Starting, stopping and deleting a managed agent, each confirmed or reported as a toast. */
export function useManagedAgentActions(agent: ManagedAgentView) {
  const label = managedAgentLabel(agent);
  const queryClient = useQueryClient();
  const { navigate } = useNavigate();
  const confirm = useShowModal('confirmActionModal');
  const [busy, setBusy] = useState(false);
  const hostedV2 = useAnsweredFlags(agent.serverId).hostedV2 === true;
  const agents = useManagedAgents(hostedV2 ? agent.serverId : null).data;
  // The owner's v2 box, by the controller hosted-machines names (never a machine's kind).
  const boxControllerId =
    useCloudMachines(hostedV2 ? agent.serverId : null).data?.find(
      (machine) => machine.backend === 'box'
    )?.controller_id ?? null;

  const act = async (fallback: string, run: () => Promise<void>) => {
    setBusy(true);
    try {
      await run();
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY] });
    } catch (failure) {
      const { headline, detail } = describeFailure(failure, fallback);
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };
  const setDesiredState = (desiredState: 'running' | 'stopped') =>
    act(
      desiredState === 'running'
        ? `${label} could not be started.`
        : `${label} could not be stopped.`,
      () =>
        rpc.managedAgents.setDesiredState({
          serverId: agent.serverId,
          agentId: agent.agentId,
          desiredState,
        })
    );
  const remove = () =>
    confirm({
      title: `Delete ${label}?`,
      description: deleteDescription(agent, agents, boxControllerId),
      confirmLabel: 'Delete',
      onSuccess: () =>
        void act(`${label} could not be deleted.`, async () => {
          await rpc.managedAgents.remove({
            serverId: agent.serverId,
            agentId: agent.agentId,
            confirmedWithdraw: confirmedWithdraw(agent, agents, boxControllerId),
          });
          // Its name is free again: the New agent form checks names against this list.
          await queryClient.invalidateQueries({ queryKey: ['workspace-agents'] });
          navigate('serverAgents', { serverId: agent.serverId });
        }),
    });

  return { busy, setDesiredState, remove };
}
