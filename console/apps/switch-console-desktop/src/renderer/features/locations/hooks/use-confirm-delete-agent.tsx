import { useQueryClient } from '@tanstack/react-query';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { log } from '@renderer/utils/logger';

export function useConfirmDeleteAgent() {
  const showDeleteAgent = useShowModal('deleteAgentModal');
  const { toast } = useToast();
  const queryClient = useQueryClient();

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

    const location = getLocationManagerStore().locations.get(locationId)?.data ?? null;

    showDeleteAgent({
      agentId: resolvedAgentId,
      agentLabel: locationLabel,
      sshHost: location?.sshHost ?? null,
      dir: location?.dir ?? null,
      onSuccess: ({ deleteInSwitch, removeProvisionedFiles }) => {
        void (async () => {
          try {
            await getLocationManagerStore().removeAgent(locationId, resolvedAgentId, {
              deleteInSwitch,
              removeProvisionedFiles,
            });
            // Refresh the detail views that list a location's agents (settings
            // sections, delete modal) so the removed agent drops and its siblings
            // stay (CHOO-1440).
            void queryClient.invalidateQueries({ queryKey: ['location-agents', locationId] });
            void queryClient.invalidateQueries({ queryKey: ['agents'] });
            onDeleted?.();
          } catch (error) {
            log.error('Failed to remove agent', { agentId: resolvedAgentId, error });
            const { headline, detail } = describeFailure(error, 'Could not remove the agent.');
            toast({
              title: headline,
              description: detail ?? undefined,
              variant: 'destructive',
            });
          }
        })();
      },
    });
  };
}
