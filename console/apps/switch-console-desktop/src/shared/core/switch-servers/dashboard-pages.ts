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
 * Where a workspace's or an organization's settings live in the dashboard:
 * under `/settings`, which opens on the page you last had open there, or else
 * General.
 */
export function settingsPagePath(link: 'workspace-settings' | 'organization-settings'): string {
  return link === 'workspace-settings' ? 'settings' : 'settings/org';
}

/**
 * The dashboard pages where the deployment's connector apps are set up.
 * `organization-settings`: on a server that says who may manage them
 * (`can_manage_connector_apps` on its session). `platform`: on a server from
 * before that, which keeps them under Platform.
 */
export type ConnectorAppsPage = 'organization-settings' | 'platform';

/** Where `page` is on the dashboard. */
export function connectorAppsPagePath(page: ConnectorAppsPage): string {
  return page === 'organization-settings' ? 'settings/org/connector-apps' : 'platform/connectors';
}

/** A room's page. */
export function roomPagePath(roomId: string): string {
  return `rooms/${roomId}`;
}

/** An agent's page. */
export function agentPagePath(agentId: string): string {
  return `agents/${agentId}`;
}
