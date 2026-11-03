export type AdminSection = 'connectors' | 'apps';

export type AdminScope = 'workspace' | 'server';

export const ADMIN_MENU_LABELS = {
  connectors: 'Connectors',
  apps: 'Connector apps',
} as const satisfies Record<AdminSection, string>;

export type AdminGroup = { scope: AdminScope; items: AdminSection[] };

/**
 * The Admin menu's entries the signed-in account may use, grouped by what
 * they reach. Each is there only for the role that may use it, so nobody is
 * shown a control the server would refuse, and only where the server has
 * service connections on.
 *
 * Admin holds only what the web gateway does not have yet. The workspace's
 * connector switches are its admins' (the server's operator administers every
 * workspace). The apps connectors sign in through are the operator's, and are
 * in the gateway, so they are here only for a Switch that serves no gateway:
 * one this Console runs without Docker. A server's status is in Settings.
 * A group with nothing in it is left out.
 */
export function adminGroups(person: {
  administers: boolean;
  operatesGatewaylessServer: boolean;
  serviceConnections: boolean;
}): AdminGroup[] {
  const { serviceConnections } = person;
  const groups: AdminGroup[] = [
    {
      scope: 'workspace',
      items: serviceConnections && person.administers ? ['connectors'] : [],
    },
    {
      scope: 'server',
      items: serviceConnections && person.operatesGatewaylessServer ? ['apps'] : [],
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}

/**
 * The section to show: the one asked for when the person may use it,
 * otherwise the first they may. Null when they may use none.
 */
export function shownAdminSection(
  groups: AdminGroup[],
  asked: AdminSection | undefined
): AdminSection | null {
  const sections = groups.flatMap((group) => group.items);
  if (asked !== undefined && sections.includes(asked)) return asked;
  return sections[0] ?? null;
}
