export type WorkspaceNavView =
  | 'server'
  | 'serverAgents'
  | 'serverRooms'
  | 'library'
  | 'templates'
  | 'connectors'
  | 'admin';

/**
 * The active server's destinations, in order. Connectors follows Templates
 * only where the server has service connections on: with them off its routes
 * are not mounted, so there is nothing to show. Admin is there when it holds
 * something the person may use (`adminGroups`).
 */
export function workspaceNavViews(server: {
  serviceConnections: boolean;
  /** Whether Admin has any section for this person. */
  admin: boolean;
}): WorkspaceNavView[] {
  return [
    'server',
    'serverAgents',
    'serverRooms',
    'library',
    'templates',
    ...(server.serviceConnections ? (['connectors'] as const) : []),
    ...(server.admin ? (['admin'] as const) : []),
  ];
}
