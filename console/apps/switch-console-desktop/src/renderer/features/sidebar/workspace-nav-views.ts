export type WorkspaceNavView =
  | 'server'
  | 'serverAgents'
  | 'serverRooms'
  | 'library'
  | 'templates'
  | 'connectors';

/**
 * The active server's destinations, in order. Connectors follows Templates
 * only where the server has service connections on: with them off its routes
 * are not mounted, so there is nothing to show. What admins look after is in
 * Settings, below these.
 */
export function workspaceNavViews(server: { serviceConnections: boolean }): WorkspaceNavView[] {
  return [
    'server',
    'serverAgents',
    'serverRooms',
    'library',
    'templates',
    ...(server.serviceConnections ? (['connectors'] as const) : []),
  ];
}
