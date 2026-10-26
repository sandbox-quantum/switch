import { useQuery } from '@tanstack/react-query';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
import { serverAvailability } from '@renderer/features/switch-servers/server-availability';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { rpc } from '@renderer/lib/ipc';

/**
 * How often the page reads the machines again: often enough that a machine
 * going on- or offline shows while the page is looked at. react-query pauses
 * while the window is hidden.
 */
const MACHINES_REFRESH_MS = 5_000;

/**
 * Every one of the signed-in user's machines on the server, revoked ones
 * included, with all each last reported. `null` means the server runs no
 * agent management. Under the managed agents' key, so whatever refreshes
 * those refreshes this too.
 */
export function useMachineDetails(serverId: string) {
  const signedIn =
    switchServersStore.isConnected(serverId) && serverAvailability(serverId) !== 'dormant';
  return useQuery({
    queryKey: [
      MANAGED_AGENTS_KEY,
      serverId,
      'machine-details',
      workspacesStore.idOnServerInScope(serverId),
    ],
    queryFn: () => rpc.managedAgents.machineDetails(serverId),
    enabled: signedIn,
    refetchInterval: MACHINES_REFRESH_MS,
    retry: false,
  });
}
