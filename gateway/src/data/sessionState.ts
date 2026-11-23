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

const SIGNED_OUT_KEY = "switch.signedOut";

/** Local storage, so every tab sees it: someone who signed out on purpose is
 * not handed straight back to the identity provider, whose own session
 * outlives Switch's and would sign them in again unasked. Kept until the next
 * sign-in. */
export function markSignedOut(): void {
  window.localStorage.setItem(SIGNED_OUT_KEY, "1");
}

export function signedOutOnPurpose(): boolean {
  return window.localStorage.getItem(SIGNED_OUT_KEY) !== null;
}

const HAND_OFF_KEY = "switch.ssoHandOffAt";

/** How long after leaving for the identity provider coming back signed out
 * means the sign-in did not finish, rather than someone arriving afresh. */
export const HAND_OFF_WINDOW_MS = 60_000;

export function noteHandOff(now: number): void {
  window.sessionStorage.setItem(HAND_OFF_KEY, String(now));
}

/** Whether this tab left for the identity provider within the window. Back
 * signed out that soon, handing off again would only loop. */
export function handedOffRecently(now: number): boolean {
  const at = Number(window.sessionStorage.getItem(HAND_OFF_KEY));
  return at > 0 && now - at < HAND_OFF_WINDOW_MS;
}

const SIGN_OUT_NOTICE_KEY = "switch.signOutNotice";

/** Session storage, so it rides along when signing out sends the browser to
 * WorkOS to end its sign-in there and back to sign-in: what signing out could
 * not do, for the sign-in page to say. */
export function keepSignOutNotice(notice: string): void {
  window.sessionStorage.setItem(SIGN_OUT_NOTICE_KEY, notice);
}

export function readSignOutNotice(): string | null {
  return window.sessionStorage.getItem(SIGN_OUT_NOTICE_KEY);
}

export function clearSignOutNotice(): void {
  window.sessionStorage.removeItem(SIGN_OUT_NOTICE_KEY);
}

/** Signed in: neither the sign-out nor a hand-off still counts. */
export function clearSignInMarks(): void {
  window.localStorage.removeItem(SIGNED_OUT_KEY);
  window.sessionStorage.removeItem(HAND_OFF_KEY);
  window.sessionStorage.removeItem(SIGN_OUT_NOTICE_KEY);
}

const NEXT_LIMIT = 2048;

/** Control characters, which a browser drops from an address before reading
 * it: `/\t/evil.example` would arrive as `//evil.example`, another site. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** `value` as a place on this dashboard to land after signing in, or null
 * when it is not one: anything a browser could read as another site (a
 * scheme, `//`, a backslash, a control character) lands on the home page
 * instead. The server checks the same of what it is sent, and also that it
 * is one of the dashboard's pages. */
export function dashboardLocation(value: string | null): string | null {
  if (value === null || value === "" || value.length > NEXT_LIMIT) return null;
  if (CONTROL_CHARACTER.test(value)) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  return value;
}

/** Where signing in should land someone sent to sign-in from `path` and
 * `search`: null for the home page, which is where it lands anyway. */
export function nextAfterSignIn(path: string, search: string): string | null {
  if (path === "/" || path === "/login") return null;
  return dashboardLocation(`${path}${search}`);
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
        text: `No e-mail was sent — e-mail isn't set up here. Send this link to ${email} yourself; it is shown only once.`,
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
