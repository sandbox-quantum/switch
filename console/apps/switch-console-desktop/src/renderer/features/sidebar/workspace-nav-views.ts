export type WorkspaceNavView =
  | 'server'
  | 'serverAgents'
  | 'serverRooms'
  | 'connectors'
  | 'templates'
  | 'admin';

/**
 * The active server's destinations, in order. Connectors follows Your Rooms
 * only where the server has service connections on: with them off its routes
 * are not mounted, so there is nothing to show. Admin is for whoever
 * administers the workspace (the server's operator among them), whose
 * decision routing is there whatever the flags, and for whoever runs the
 * server from this Console, whose status is under Admin's Server heading:
 * the others are run by someone else, and there is nothing here to start,
 * stop or update.
 */
export function workspaceNavViews(server: {
  managed: boolean;
  serviceConnections: boolean;
  administers: boolean;
}): WorkspaceNavView[] {
  const admin = server.administers || server.managed;
  return [
    'server',
    'serverAgents',
    'serverRooms',
    ...(server.serviceConnections ? (['connectors'] as const) : []),
    'templates',
    ...(admin ? (['admin'] as const) : []),
  ];
}

/**
 * Where the sidebar's Admin opens: the Admin page, on the first section the
 * person may use, or the status of the server this Console runs where they
 * have no section of their own. While that server can't answer it is always
 * the status, the one entry that works without it.
 */
export function adminNavTarget(server: {
  administers: boolean;
  frozen: boolean;
}): 'admin' | 'managedServer' {
  return server.administers && !server.frozen ? 'admin' : 'managedServer';
}
