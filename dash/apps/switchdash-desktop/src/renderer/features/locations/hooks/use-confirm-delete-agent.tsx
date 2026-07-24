import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { log } from '@renderer/utils/logger';

export function useConfirmDeleteAgent() {
  const showDeleteAgent = useShowModal('deleteAgentModal');
  const { toast } = useToast();

  return async ({
    locationId,
    locationLabel,
    onDeleted,
  }: {
    locationId: string;
    locationLabel: string;
    onDeleted?: () => void;
  }) => {
    // Resolve the specific agent at this location so the delete is per-agent
    // (creds teardown + optional Switch delete), not a blanket location removal.
    const agents = await rpc.agents.getAgents(locationId);
    const agent = agents[0];
    if (!agent) return;

    showDeleteAgent({
      agentId: agent.id,
      agentLabel: locationLabel,
      onSuccess: ({ deleteInSwitch }) => {
        void (async () => {
          try {
            await getLocationManagerStore().removeAgent(locationId, agent.id, { deleteInSwitch });
            onDeleted?.();
          } catch (error) {
            log.error('Failed to remove agent', { agentId: agent.id, error });
            toast({
              title: 'Failed to remove agent',
              description: error instanceof Error ? error.message : String(error),
              variant: 'destructive',
            });
          }
        })();
      },
    });
  };
}
