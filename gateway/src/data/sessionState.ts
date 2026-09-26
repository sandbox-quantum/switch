import type { EmailDelivery, Session } from "./api";

/** Which top-level screen the app shows. Pure, so the order of precedence is
 * testable without rendering anything. */
export type AppView =
  | "signed_out"
  | "accept_invite"
  | "needs_workspace"
  | "needs_selection"
  | "ready";

/** A pending invitation outranks everything a signed-in person could
 * otherwise be shown: someone who followed an invite link came to join that
 * workspace, not to create one or to pick among the ones they already have. */
export function appView(session: Session | null, pendingInvite: string | null): AppView {
  if (session === null) return "signed_out";
  if (pendingInvite !== null) return "accept_invite";
  return session.state;
}

/** May this session administer the workspace it is in? The operator bit, or
 * owner/admin of the current workspace — the same rule the server applies
 * (`require_tenant_admin`). */
export function canAdminTenant(session: Session | null): boolean {
  if (session === null) return false;
  if (session.user.is_operator) return true;
  const role = session.tenant?.role;
  return role === "owner" || role === "admin";
}

const INVITE_KEY = "switch.pendingInvite";

/** Session storage, not local: an invite token is a bearer credential, and
 * it should not outlive the tab that followed the link. */
export function readPendingInvite(): string | null {
  return window.sessionStorage.getItem(INVITE_KEY);
}

export function storePendingInvite(token: string): void {
  window.sessionStorage.setItem(INVITE_KEY, token);
}

export function clearPendingInvite(): void {
  window.sessionStorage.removeItem(INVITE_KEY);
}

/** The token in an invite link's fragment (`#token=…`), or null. */
export function inviteTokenFromHash(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, "")).get("token");
}

/** An invite token from whatever someone pasted: the full link, or the bare
 * token. Null when there is nothing token-like in it. */
export function inviteTokenFrom(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  try {
    return inviteTokenFromHash(new URL(trimmed).hash);
  } catch {
    return /\s/.test(trimmed) ? null : trimmed;
  }
}

/** The token rides in the fragment, which the browser never sends, so it
 * stays out of proxy and access logs — the same reason the accept call takes
 * it in the request body. */
export function inviteUrl(origin: string, token: string): string {
  return `${origin}/invite#token=${encodeURIComponent(token)}`;
}

/** May this session change who owns the workspace — grant or revoke the
 * owner role? Narrower than `canAdminTenant`, matching the server's
 * `owns_tenant`. */
export function ownsTenant(session: Session | null): boolean {
  if (session === null) return false;
  return session.user.is_operator || session.tenant?.role === "owner";
}

export interface DeliveryNotice {
  severity: "success" | "warning" | "error";
  text: string;
}

/** What to tell the admin about the invitation they just created. Every
 * outcome but "sent" means the person has not heard about it, so the link
 * is theirs to pass on. */
export function deliveryNotice(delivery: EmailDelivery, email: string | null): DeliveryNotice {
  switch (delivery) {
    case "sent":
      return {
        severity: "success",
        text: `Invitation e-mailed to ${email}. The link below works too; it is shown only once.`,
      };
    case "not_configured":
      return {
        severity: "warning",
        text: `No e-mail was sent — this server has no mail set up. Send this link to ${email} yourself; it is shown only once.`,
      };
    case "failed":
      return {
        severity: "error",
        text: `Sending the e-mail to ${email} failed. The invitation was created: send this link yourself; it is shown only once.`,
      };
    case "not_requested":
      return {
        severity: "success",
        text: "Send this link to the person you are inviting. It is shown only once.",
      };
  }
}
