import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import type {
  JoinableWorkspace,
  JoinableWorkspaces,
  PendingInvitation,
  PendingInvitations,
} from '@shared/core/workspaces/invitations';

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

const NONE: PendingInvitation[] = [];

/**
 * The invitations a server listed, or none where it listed nothing: still
 * asking, failed, or too old to be asked. The views say which of those it was
 * from the query itself; this is only the rows.
 */
export function listedInvitations(data: PendingInvitations | undefined): PendingInvitation[] {
  return data?.kind === 'listed' ? data.invitations : NONE;
}

export function invitationSummary(invitation: PendingInvitation): string {
  return `${invitation.invitedBy} invited you as ${invitation.role}`;
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

const NO_JOINABLE: JoinableWorkspace[] = [];

/** The joinable workspaces a server listed, or none, as {@link listedInvitations}. */
export function listedJoinable(data: JoinableWorkspaces | undefined): JoinableWorkspace[] {
  return data?.kind === 'listed' ? data.workspaces : NO_JOINABLE;
}

export function joinableSummary(joinable: JoinableWorkspace): string {
  return `Open to anyone at ${joinable.domain}`;
}
