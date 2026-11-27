import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import type { JoinableWorkspaces, PendingInvitations } from '@shared/core/workspaces/invitations';

export function pendingInvitationsKey(serverId: string): readonly unknown[] {
  return ['pending-invitations', serverId];
}

/**
 * The invitations waiting for the signed-in account on a server.
 *
 * One query per server, shared by every view that asks, so the switcher's badge
 * and its rows cannot disagree about how many there are.
 */
export function usePendingInvitations(serverId: string): UseQueryResult<PendingInvitations> {
  return useQuery({
    queryKey: pendingInvitationsKey(serverId),
    queryFn: () => rpc.switchServers.listPendingInvitations(serverId),
    staleTime: 60_000,
  });
}

export function InvitedBadge() {
  return (
    <span className="shrink-0 rounded bg-[var(--sel-soft)] px-1 py-px text-[10px] font-medium tracking-wide text-foreground uppercase">
      Invited
    </span>
  );
}

export function joinableWorkspacesKey(serverId: string): readonly unknown[] {
  return ['joinable-workspaces', serverId];
}

/**
 * The workspaces open to the signed-in account's domain on a server, shared
 * the way {@link usePendingInvitations} is.
 */
export function useJoinableWorkspaces(serverId: string): UseQueryResult<JoinableWorkspaces> {
  return useQuery({
    queryKey: joinableWorkspacesKey(serverId),
    queryFn: () => rpc.switchServers.listJoinableWorkspaces(serverId),
    staleTime: 60_000,
  });
}
