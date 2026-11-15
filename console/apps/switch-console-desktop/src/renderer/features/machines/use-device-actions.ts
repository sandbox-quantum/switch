import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import type { MachineDetail } from '@shared/core/managed-agents/managed-agents';
import type { PlacedAgents } from './machine-state';

/**
 * Renaming and removing one of the person's devices, as its card and its page
 * both offer them. Switch names the cloud machine, so it is not renamed; this
 * computer and SSH hosts belong to the Console that set them up, which takes
 * them away itself, so only a standalone machine is removed from here.
 */
export function useDeviceActions(serverId: string, machine: MachineDetail, placed: PlacedAgents) {
  const showRenameModal = useShowModal('renameMachineModal');
  const showConfirm = useShowModal('confirmActionModal');
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const live = machine.state !== 'revoked';
  const local = machine.local;

  // This computer's and this Console's SSH hosts' controllers are Console's to
  // run, so it can start one that stopped (an error, or another copy took over).
  const restart = async () => {
    if (!local) return;
    setRestarting(true);
    setError(null);
    try {
      if (local.kind === 'this-computer') await rpc.embeddedController.restart(serverId);
      else await rpc.hostControllers.restart({ sshHost: local.sshHost, serverId });
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId] });
    } catch (err) {
      setError(failureText(err, `Could not restart the agent controller on ${machine.name}.`));
    } finally {
      setRestarting(false);
    }
  };

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
        placed.kind === 'unreadable'
          ? `${machine.name} stops running agents for you and cannot reconnect. Your agents could not be listed, so this cannot say which are on it: any on it stop, and run again once you put them on another device.`
          : placed.kind === 'known' && placed.count > 0
            ? `${machine.name} stops running agents for you and cannot reconnect. ${placed.count === 1 ? 'The agent on it stops, and runs again once you put it on another device.' : `The ${placed.count} agents on it stop, and run again once you put them on another device.`}`
            : `${machine.name} stops running agents for you and cannot reconnect. To use it again, enroll it again.`,
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
    removable: live && !machine.cloud && machine.local === null && placed.kind !== 'loading',
    restartable: live && local !== null,
    restarting,
    rename,
    remove,
    restart,
    error,
  };
}
