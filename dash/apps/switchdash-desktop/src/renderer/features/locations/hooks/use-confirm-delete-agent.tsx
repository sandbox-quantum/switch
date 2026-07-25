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
    agentId,
    locationLabel,
    onDeleted,
  }: {
    locationId: string;
    /** The specific agent to delete. Omit to fall back to the location's first
     * agent (legacy single-agent callers). */
    agentId?: string;
    locationLabel: string;
    onDeleted?: () => void;
  }) => {
    // Resolve the specific agent so the delete is per-agent (creds teardown +
    // optional Switch delete), not a blanket location removal.
    let targetAgentId = agentId;
    if (!targetAgentId) {
      const agents = await rpc.agents.getAgents(locationId);
      targetAgentId = agents[0]?.id;
    }
    if (!targetAgentId) return;
    const resolvedAgentId = targetAgentId;

    showDeleteAgent({
      agentId: resolvedAgentId,
      agentLabel: locationLabel,
      onSuccess: ({ deleteInSwitch }) => {
        void (async () => {
          try {
            await getLocationManagerStore().removeAgent(locationId, resolvedAgentId, {
              deleteInSwitch,
            });
            onDeleted?.();
          } catch (error) {
            log.error('Failed to remove agent', { agentId: resolvedAgentId, error });
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
