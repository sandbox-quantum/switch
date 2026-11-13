/**
 * The web dashboard pages Switch Console opens, as paths on the dashboard's
 * address. Plain data with no imports: the dashboard's own tests read this
 * file (`gateway/src/routes/consoleLinks.test.ts`) and fail when it no
 * longer routes a page named here, so renaming one there cannot break these
 * links without anyone noticing.
 */

/**
 * The query parameter naming the workspace a link is for. The dashboard
 * switches to that workspace on arrival.
 */
export const WORKSPACE_PARAM = 'workspace';

/**
 * Where a workspace's or an organization's settings live in the dashboard. In
 * its new layout (`gateway_v2`) both are under `/settings`, which opens on the
 * page you last had open there, or else General. Today's layout, and every
 * server from before the new one, has them at `/workspace` and
 * `/organization`. The new layout redirects those too, but `/workspace` lands
 * on its Users page.
 */
export function settingsPagePath(
  link: 'workspace-settings' | 'organization-settings',
  newLayout: boolean
): string {
  if (link === 'workspace-settings') return newLayout ? 'settings' : 'workspace';
  return newLayout ? 'settings/org' : 'organization';
}

/** A room's page, in either layout. */
export function roomPagePath(roomId: string): string {
  return `rooms/${roomId}`;
}

/** An agent's page, in either layout. */
export function agentPagePath(agentId: string): string {
  return `agents/${agentId}`;
}
