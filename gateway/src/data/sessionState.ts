import type { Session } from "./api";

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

/** An invite token from whatever someone pasted: the full link, or the bare
 * token. Null when there is nothing token-like in it. */
export function inviteTokenFrom(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  try {
    const url = new URL(trimmed);
    return url.searchParams.get("token");
  } catch {
    return /\s/.test(trimmed) ? null : trimmed;
  }
}

export function inviteUrl(origin: string, token: string): string {
  return `${origin}/invite?token=${encodeURIComponent(token)}`;
}

/** May this session change who owns the workspace — grant or revoke the
 * owner role? Narrower than `canAdminTenant`, matching the server's
 * `owns_tenant`. */
export function ownsTenant(session: Session | null): boolean {
  if (session === null) return false;
  return session.user.is_operator || session.tenant?.role === "owner";
}
