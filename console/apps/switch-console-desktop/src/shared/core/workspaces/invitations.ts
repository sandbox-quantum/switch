import type { WorkspaceRole } from './workspaces';

/** An invitation to a workspace, as the gateway lists it to the workspace's admins. */
export type Invitation = {
  id: string;
  role: WorkspaceRole;
  /** The one address that may accept it, or null for anyone holding the link. */
  email: string | null;
  /** ISO 8601. */
  expiresAt: string;
  usesRemaining: number;
  /** ISO 8601, or null while it has not been revoked. */
  revokedAt: string | null;
  createdAt: string;
};

/**
 * What became of the e-mail an invitation asked for.
 *
 * `not_requested` is an invitation that named no address; `not_configured` a
 * server with no mail relay; `failed` a relay that refused or could not be
 * reached; `unsupported` a server older than e-mailed invitations, which never
 * sends one. The invitation stands in every case, and its link is the way in.
 */
export type InvitationEmailDelivery =
  | 'sent'
  | 'not_configured'
  | 'failed'
  | 'not_requested'
  | 'unsupported';

export type CreateInvitationParams = {
  workspaceId: string;
  role: WorkspaceRole;
  email: string | null;
  expiresInHours: number;
  usesRemaining: number;
};

/**
 * A new invitation and the link to it.
 *
 * The link is only ever available here: the server keeps a hash of the token,
 * so once this is dismissed nobody can show it again.
 */
export type CreatedInvitation = {
  invitation: Invitation;
  link: string;
  emailDelivery: InvitationEmailDelivery;
};

/**
 * A workspace's invitations, and whether an addressed one is e-mailed.
 *
 * `emailEnabled` is null on a server older than e-mailed invitations: it never
 * sends one, but "no e-mail set up" would name a setting it does not have.
 */
export type WorkspaceInvitations = {
  invitations: Invitation[];
  emailEnabled: boolean | null;
};

export type InvitationStatus = 'active' | 'revoked' | 'expired' | 'used';

/** Whether an invitation can still be accepted, and if not, why not. */
export function invitationStatus(invitation: Invitation, now: number): InvitationStatus {
  if (invitation.revokedAt !== null) return 'revoked';
  if (new Date(invitation.expiresAt).getTime() <= now) return 'expired';
  if (invitation.usesRemaining <= 0) return 'used';
  return 'active';
}

/**
 * The link an invitee opens or pastes into Switch Console.
 *
 * Built from the gateway's own address, as the server's dashboard builds it
 * from the page it is served on: both are the origin that answers `/gateway`.
 * The token rides in the fragment, which a browser never sends, so it stays out
 * of proxy and access logs.
 */
export function inviteLink(gatewayUrl: string, token: string): string {
  return `${gatewayUrl.replace(/\/+$/, '')}/invite#token=${encodeURIComponent(token)}`;
}

/**
 * An invitation addressed to the signed-in account, in a workspace it is not a
 * member of yet. Accepted by id: the account's own address stands in for the
 * link, so there is no token to hold.
 */
export type PendingInvitation = {
  id: string;
  /** The gateway's id for the workspace it would join. */
  tenantId: string;
  workspaceName: string;
  role: WorkspaceRole;
  /** ISO 8601. */
  expiresAt: string;
  /** The inviter's name, as the server has it. */
  invitedBy: string;
};

/**
 * The invitations waiting for the signed-in account on one server.
 *
 * `unsupported` is a server older than the route that lists them. It is not the
 * same answer as an empty list — that server cannot say whether anyone invited
 * you — so it is kept apart for the views to leave the section out rather than
 * claim there is nothing in it.
 */
export type PendingInvitations =
  | { kind: 'listed'; invitations: PendingInvitation[] }
  | { kind: 'unsupported' };

/**
 * A workspace open to the domain of the signed-in account's address, that the
 * account is not a member of yet. Joining it needs no invitation and grants
 * the member role.
 */
export type JoinableWorkspace = {
  /** The gateway's id for the workspace. */
  tenantId: string;
  workspaceName: string;
  /** The domain it is open to — the account's own. */
  domain: string;
};

/**
 * The workspaces the signed-in account may join by its domain on one server.
 * `unsupported` is a server older than the route, kept apart from an empty
 * list for the reason `PendingInvitations` gives.
 */
export type JoinableWorkspaces =
  | { kind: 'listed'; workspaces: JoinableWorkspace[] }
  | { kind: 'unsupported' };

/**
 * The e-mail domains a workspace lets people join from, as its admins see
 * them, and whether the signed-in admin could add their own.
 *
 * An admin may open a workspace only to the domain of their own address, so
 * `ownDomain` is the one domain on offer and `ownDomainRefusal` says why it
 * cannot be added when it cannot — a public e-mail provider's, say.
 */
export type WorkspaceJoinDomains =
  | {
      kind: 'listed';
      domains: string[];
      ownDomain: string;
      ownDomainRefusal: string | null;
    }
  | { kind: 'unsupported' };
