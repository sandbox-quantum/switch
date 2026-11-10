import { useQuery } from '@tanstack/react-query';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { rpc } from '@renderer/lib/ipc';

export const CLOUD_MACHINES_KEY = 'cloud-machines';

/**
 * Whether the server's workspace on screen went unasked because Switch Console
 * is not signed in to the server: the sidebar already says to sign in.
 */
function serverNotSignedIn(serverId: string | null): boolean {
  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  return switchRoomsStore.workspacesNotSignedIn.some((workspace) => workspace.id === workspaceId);
}

/**
 * The caller's cloud machines on the server. Not asked while signed out: the
 * sidebar already says to sign in.
 *
 * `null` means the server has no cloud machines. It is not asked again until
 * its session changes, which is when it may have gained them.
 */
export function useCloudMachines(serverId: string | null) {
  const signedOut = serverNotSignedIn(serverId);
  const user = serverId === null ? null : (switchServersStore.statusFor(serverId)?.user ?? null);
  return useQuery({
    queryKey: [CLOUD_MACHINES_KEY, serverId, user?.id ?? null],
    queryFn: () => rpc.switchServers.cloudMachines(serverId!),
    enabled: serverId !== null && !signedOut,
    refetchInterval: (query) => (query.state.data === null ? false : 5000),
    retry: false,
  });
}
