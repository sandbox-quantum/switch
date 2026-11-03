export type WorkspaceNavView =
  | 'server'
  | 'serverAgents'
  | 'serverRooms'
  | 'templates'
  | 'connectors'
  | 'admin';

/**
 * The active server's destinations, in order. Connectors follows Templates
 * only where the server has service connections on: with them off its routes
 * are not mounted, so there is nothing to show.
 *
 * Admin holds only what has no other home yet. Workspace and server settings
 * belong to the server's web gateway; what is still here is the workspace's
 * connector switches, for whoever administers the workspace (the gateway has
 * no page for them yet), and connector apps for the operator of a Switch this
 * Console runs without a gateway of its own. A Switch this Console runs is
 * operated from Settings → System status, not from here.
 */
export function workspaceNavViews(server: {
  serviceConnections: boolean;
  administers: boolean;
  /** The operator of a Switch this Console runs that serves no web gateway. */
  operatesGatewaylessServer: boolean;
}): WorkspaceNavView[] {
  const admin =
    server.serviceConnections && (server.administers || server.operatesGatewaylessServer);
  return [
    'server',
    'serverAgents',
    'serverRooms',
    'templates',
    ...(server.serviceConnections ? (['connectors'] as const) : []),
    ...(admin ? (['admin'] as const) : []),
  ];
}
