import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import type { MachineDetail } from '@shared/core/managed-agents/managed-agents';

/**
 * Renaming and removing one of the person's devices, as its card and its page
 * both offer them. Switch names the cloud machine, so it is not renamed; this
 * computer and SSH hosts belong to the Console that set them up, which takes
 * them away itself, so only a standalone machine is removed from here.
 */
export function useDeviceActions(serverId: string, machine: MachineDetail, agentCount: number) {
  const showRenameModal = useShowModal('renameMachineModal');
  const showConfirm = useShowModal('confirmActionModal');
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const live = machine.state !== 'revoked';

  const rename = () =>
    showRenameModal({
      serverId,
      machineId: machine.id,
      currentName: machine.name,
      currentDescription: machine.description,
    });

  const remove = () =>
    showConfirm({
      title: `Remove ${machine.name}?`,
      description:
        agentCount === 0
          ? `${machine.name} stops running agents for you and cannot reconnect. To use it again, enroll it again.`
          : `${machine.name} stops running agents for you and cannot reconnect. The ${agentCount === 1 ? 'agent' : `${agentCount} agents`} on it stay placed on it and do not run until you move them.`,
      confirmLabel: 'Remove',
      onSuccess: () => {
        setError(null);
        rpc.managedAgents
          .removeMachine({ serverId, machineId: machine.id })
          .then(() => queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId] }))
          .catch((err: unknown) => setError(failureText(err, `Could not remove ${machine.name}.`)));
      },
    });

  return {
    renamable: live && !machine.cloud,
    removable: live && !machine.cloud && machine.local === null,
    rename,
    remove,
    error,
  };
}
