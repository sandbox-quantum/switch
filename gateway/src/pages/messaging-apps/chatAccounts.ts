import type {
  BridgeDetail,
  ClaimedAccount,
  LinkCode,
  LinkedIdentity,
  PendingIdentity,
} from "../../data/api";

/** One of the signed-in person's accounts in a messaging app.
 *
 * `linked` counts. `unverified` counts too, but was made before links had to
 * be confirmed, and its owner is asked to confirm it. `pending` counts for
 * nothing until a code is posted from the account. */
export type AccountLine =
  | { kind: "linked" | "unverified"; id: string; username: string; linkedAt: string }
  | { kind: "pending"; id: string; username: string; requestedBy: string | null };

export interface AppAccounts {
  app: BridgeDetail;
  accounts: AccountLine[];
}

/** Every messaging app with the person's accounts in it, by name. One person
 * may hold several accounts in one app, and a link waiting next to one that
 * counts, so an app carries a list rather than one account. */
export function accountsByApp(
  apps: readonly BridgeDetail[],
  linked: readonly LinkedIdentity[],
  pending: readonly PendingIdentity[],
): AppAccounts[] {
  return [...apps]
    .sort((a, b) => a.display_name.localeCompare(b.display_name))
    .map((app) => ({
      app,
      accounts: [
        ...linked
          .filter((i) => i.bridge_id === app.bridge_id)
          .map(
            (i): AccountLine => ({
              kind: i.verified ? "linked" : "unverified",
              id: i.id,
              username: i.external_username,
              linkedAt: i.linked_at,
            }),
          ),
        ...pending
          .filter((p) => p.bridge_id === app.bridge_id)
          .map(
            (p): AccountLine => ({
              kind: "pending",
              id: p.id,
              username: p.external_username,
              requestedBy: p.requested_by_name,
            }),
          ),
      ],
    }));
}

/** A platform username as a handle. Some platforms report it with the sigil
 * already on, so one is added only when it is missing. */
export function accountHandle(username: string): string {
  return username.startsWith("@") ? username : `@${username}`;
}

/** The link a code confirms. A `pending` link is dropped by cancelling; an
 * `unverified` one keeps counting, and cancelling withdraws only the code. */
export interface LinkTarget {
  /** The account's row id. */
  identityId: string;
  username: string;
  kind: "pending" | "unverified";
}

/** What a claim came back as: already linked and confirmed, or a link
 * waiting for a code, which the claim returns when it is the caller's own. */
export function afterClaim(
  claimed: ClaimedAccount,
): { kind: "linked" } | { kind: "confirm"; target: LinkTarget; code: LinkCode | null } {
  const request = claimed.link_request;
  if (request === null) return { kind: "linked" };
  const alreadyLinked = claimed.claimed_by.some((c) => c.user_id === request.user_id);
  return {
    kind: "confirm",
    target: {
      identityId: claimed.id,
      username: claimed.external_username,
      kind: alreadyLinked ? "unverified" : "pending",
    },
    code: request.code,
  };
}

/** The commands a code's instructions say to post: the parts in backticks.
 * Unbalanced backticks mean there is no markup to trust, so none. */
export function commandsIn(instructions: string): string[] {
  const parts = instructions.split("`");
  if (parts.length % 2 === 0) return [];
  return parts.filter((_, i) => i % 2 === 1);
}

/** When a code stops working, on this machine's clock: counted from when it
 * arrived by the lifetime Switch gave it, so a clock that is minutes out still
 * counts the right minutes. */
export function codeDeadline(code: LinkCode, arrivedAt: number): number {
  return arrivedAt + code.expires_in_seconds * 1000;
}

/** Whether a link looks to have been dropped somewhere else: an admin,
 * another tab, unlinking, or "Not me" or a wrong number tapped in the message
 * Switch sent the account.
 *
 * A pending link looks so when it is in neither list. Confirming turns the
 * request into a link in one step, but the lists are read apart, so a pair of
 * reads can straddle it, and a pending read made before the screen opened
 * says nothing. An older link is never in the pending list, so it looks so
 * when it leaves the linked list after this screen saw it there ("Not me"
 * removes it). Either way the caller settles it with a fresh read of the
 * linked accounts begun after this one. */
export function looksCancelled({
  target,
  linked,
  pending,
  pendingReadAt,
  openedAt,
  sawListed,
}: {
  target: LinkTarget;
  linked: readonly LinkedIdentity[] | null;
  pending: readonly PendingIdentity[] | null;
  pendingReadAt: number;
  openedAt: number;
  /** This screen has seen the link in the linked list. */
  sawListed: boolean;
}): boolean {
  if (linked === null || linked.some((i) => i.id === target.identityId)) return false;
  if (target.kind === "unverified") return sawListed;
  return pending !== null && pendingReadAt >= openedAt && !pending.some((p) => p.id === target.identityId);
}

/** Why nothing can be looked up or confirmed in an app right now, or null
 * when it can. Searching, linking and getting a code all ask the platform,
 * which a messaging app that is not running cannot. */
export function unavailableReason(app: BridgeDetail): string | null {
  return app.status === "active"
    ? null
    : `${app.display_name} isn't running, so Switch can't look accounts up or confirm them there.`;
}

/** Where an app has no directory to search, how someone becomes findable at
 * all; null where it can be searched. */
export function findableNote(app: BridgeDetail): string | null {
  if (app.directory_search_supported) return null;
  return `${app.display_name} has no directory to search, so Switch only knows people who have written in a chat connected to it. Send a message in a connected group first, then link your account.`;
}

/** A messaging app's status as a chip colour, the same wherever it shows. */
export function statusColor(status: string): "success" | "error" | "default" {
  return status === "active" ? "success" : status === "error" ? "error" : "default";
}
