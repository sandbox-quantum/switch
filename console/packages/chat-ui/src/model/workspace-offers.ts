/**
 * What a server answered when asked for an account's invitations or for the
 * workspaces open to its domain: rows, or `unsupported` for a server older
 * than the route, which cannot say whether there are any.
 */
type Listed<Key extends string, Row> =
  | ({ kind: 'listed' } & Record<Key, Row[]>)
  | { kind: 'unsupported' };

const NONE: never[] = [];

/**
 * The invitations a server listed, or none where it listed nothing: still
 * asking, failed, or too old to be asked. The views say which of those it was
 * from the query itself; this is only the rows.
 */
export function listedInvitations<Row>(data: Listed<'invitations', Row> | undefined): Row[] {
  return data?.kind === 'listed' ? data.invitations : NONE;
}

/** The joinable workspaces a server listed, or none, as {@link listedInvitations}. */
export function listedJoinable<Row>(data: Listed<'workspaces', Row> | undefined): Row[] {
  return data?.kind === 'listed' ? data.workspaces : NONE;
}

export function invitationSummary(invitedBy: string, role: string): string {
  return `${invitedBy} invited you as ${role}`;
}

export function joinableSummary(domain: string): string {
  return `Open to anyone at ${domain}`;
}

/** What a list of workspaces to choose from holds: those the account is in, and those it can join. */
export function pickSubtitle(memberships: number, offers: number): string {
  if (offers === 0) return 'You’re a member of these.';
  if (memberships === 0) return 'You can join these.';
  return 'You’re a member of these, or can join them.';
}
