export type WorkspaceNavView =
  | 'server'
  | 'serverAgents'
  | 'serverRooms'
  | 'cloudFiles'
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
  /** Your cloud files shows for this person (`useCloudFilesVisible`: hosted v2 on). */
  cloudFiles?: boolean;
}): WorkspaceNavView[] {
  return [
    'server',
    'serverAgents',
    'serverRooms',
    // Hosted agents v2's Your cloud files, beside the person's agents and rooms.
    ...(server.cloudFiles ? (['cloudFiles'] as const) : []),
    'library',
    'templates',
    ...(server.serviceConnections ? (['connectors'] as const) : []),
    ...(server.admin ? (['admin'] as const) : []),
  ];
}
