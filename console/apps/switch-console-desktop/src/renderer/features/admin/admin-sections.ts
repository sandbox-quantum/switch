export type AdminSection = 'connectors' | 'apps';

/**
 * An entry in the Admin page's side menu: one of the page's own sections, or
 * the status of a server this Console runs, which is a view of its own
 * (`managedServer`) drawn beside the same menu.
 */
export type AdminMenuItem = AdminSection | 'status';

export type AdminScope = 'workspace' | 'server';

export const ADMIN_MENU_LABELS = {
  connectors: 'Connectors',
  apps: 'Connector apps',
  status: 'Status',
} as const satisfies Record<AdminMenuItem, string>;

export type AdminGroup = { scope: AdminScope; items: AdminMenuItem[] };

/**
 * The Admin menu's entries the signed-in account may use, grouped by what
 * they reach. Each is there only for the role that may use it, so nobody is
 * shown a control the server would refuse: the workspace's connector
 * switches are its admins' (the server's operator administers every
 * workspace), and the apps connectors sign in through are the operator's
 * alone, both only where the server has service connections on. A server
 * this Console runs has its status here for whoever runs it, whatever their
 * role on it: it is started, stopped and updated on their own computer or
 * host. A group with nothing in it is left out.
 */
export function adminGroups(person: {
  administers: boolean;
  operator: boolean;
  serviceConnections: boolean;
  managed: boolean;
}): AdminGroup[] {
  const { serviceConnections } = person;
  const groups: AdminGroup[] = [
    {
      scope: 'workspace',
      items: serviceConnections && person.administers ? ['connectors'] : [],
    },
    {
      scope: 'server',
      items: [
        ...(person.managed ? (['status'] as const) : []),
        ...(serviceConnections && person.operator ? (['apps'] as const) : []),
      ],
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}

/**
 * The Admin page's own section to show: the one asked for when the person may
 * use it, otherwise the first they may. Null when they may use none, though
 * the menu may still hold the server's status.
 */
export function shownAdminSection(
  groups: AdminGroup[],
  asked: AdminSection | undefined
): AdminSection | null {
  const sections = groups
    .flatMap((group) => group.items)
    .filter((item): item is AdminSection => item !== 'status');
  if (asked !== undefined && sections.includes(asked)) return asked;
  return sections[0] ?? null;
}
