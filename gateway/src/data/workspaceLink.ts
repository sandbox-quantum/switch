import { fetchSession, switchTenant } from "./api";

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

export type LinkOutcome = { switched: true } | { switched: false; notice: string | null };

/** Switch to the workspace a link names, when the session is somewhere else.
 *
 * Nothing to do when signed out or already there. Only a workspace among the
 * session's own is switched to: one the caller is a member of, or one their
 * organization admin role covers. The platform operator may enter any
 * workspace, and entering is recorded, so a link alone must not walk them
 * into a customer's; the page stays where it is and says so. */
export async function followWorkspaceLink(wanted: string): Promise<LinkOutcome> {
  const session = await fetchSession();
  if (session === null || session.tenant?.id === wanted) return { switched: false, notice: null };
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
