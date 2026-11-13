import { type Session, switchTenant } from "./api";

/** A link into the dashboard can name the workspace it is for
 * (`?workspace=<id>`), as Switch Console's links do, so the page it opens is
 * that workspace's rather than whichever one this browser had selected last.
 * The dashboard switches before it loads anything else. */
const WORKSPACE_PARAM = "workspace";

/** The workspace a link names, or null when it names none. */
export function linkedWorkspace(search: string): string | null {
  const id = new URLSearchParams(search).get(WORKSPACE_PARAM);
  return id === null || id === "" ? null : id;
}

/** The same address without the workspace, so that it never outlives the
 * load it was for: reloading the page, or sharing it, later must not switch
 * back. */
export function withoutLinkedWorkspace(location: {
  pathname: string;
  search: string;
  hash: string;
}): string {
  const params = new URLSearchParams(location.search);
  params.delete(WORKSPACE_PARAM);
  const search = params.toString();
  return `${location.pathname}${search === "" ? "" : `?${search}`}${location.hash}`;
}

/** A link naming a workspace: the page it opens (path, query and fragment,
 * the workspace left out) and the workspace. */
export interface WorkspaceLink {
  path: string;
  workspace: string;
}

/** `link` as an absolute address on this dashboard, naming its workspace.
 * Absolute, so that a path beginning `//` stays on this origin. */
export function linkAddress(link: WorkspaceLink): string {
  const url = new URL(`${window.location.origin}${link.path}`);
  url.searchParams.set(WORKSPACE_PARAM, link.workspace);
  return url.href;
}

/** This dashboard's absolute address for `path`, which stays on this origin
 * whatever `path` holds. */
export function onThisDashboard(path: string): string {
  return `${window.location.origin}${path}`;
}

export type LinkOutcome = { switched: true } | { switched: false; notice: string | null };

/** Switch to the workspace a link names, when `session` is somewhere else.
 *
 * Nothing to do when already there. Only a workspace among the session's own
 * is switched to: one the caller is a member of, or one their organization
 * admin role covers, which the server lists among them. The platform operator
 * may enter any workspace, and entering is recorded, so a link alone must not
 * walk them into a customer's; the page stays where it is and says so. */
export async function followWorkspaceLink(wanted: string, session: Session): Promise<LinkOutcome> {
  if (session.tenant?.id === wanted) return { switched: false, notice: null };
  if (!session.tenants.some((tenant) => tenant.id === wanted)) {
    const here = session.tenant === null ? "" : `, so this is ${session.tenant.name}`;
    return {
      switched: false,
      notice: `The link you followed is for a workspace you aren't in${here}.`,
    };
  }
  await switchTenant(wanted);
  return { switched: true };
}

/** A link followed while signed out waits here for the sign-in, which may
 * leave for a sign-in provider and come back: session storage keeps it for
 * this tab alone, and no other tab's sign-in picks it up. */
const AFTER_SIGN_IN_KEY = "switch.workspaceLinkAfterSignIn";

/** How long a kept link waits: long enough to sign in, short enough that a
 * sign-in abandoned and done much later does not open a page nobody asked
 * for. */
const AFTER_SIGN_IN_MS = 15 * 60 * 1000;

export function keepLinkForSignIn(link: WorkspaceLink): void {
  window.sessionStorage.setItem(AFTER_SIGN_IN_KEY, JSON.stringify({ ...link, at: Date.now() }));
}

/** The link kept for after the sign-in, once: taking it forgets it. Null
 * when there is none, or it waited too long. */
export function takeLinkAfterSignIn(): WorkspaceLink | null {
  const raw = window.sessionStorage.getItem(AFTER_SIGN_IN_KEY);
  window.sessionStorage.removeItem(AFTER_SIGN_IN_KEY);
  if (raw === null) return null;
  let kept: unknown;
  try {
    kept = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof kept !== "object" || kept === null) return null;
  const { path, workspace, at } = kept as Record<string, unknown>;
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  if (typeof workspace !== "string" || typeof at !== "number") return null;
  if (Date.now() - at > AFTER_SIGN_IN_MS) return null;
  return { path, workspace };
}

export function forgetLinkForSignIn(): void {
  window.sessionStorage.removeItem(AFTER_SIGN_IN_KEY);
}
