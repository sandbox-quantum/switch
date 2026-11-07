export type AdminSection = 'messaging-apps' | 'connectors' | 'switch-trust' | 'apps';

export type AdminScope = 'workspace' | 'server';

export const ADMIN_MENU_LABELS = {
  'messaging-apps': 'Messaging apps',
  connectors: 'Connectors',
  'switch-trust': 'Switch Trust',
  apps: 'Connector apps',
} as const satisfies Record<AdminSection, string>;

export type AdminGroup = { scope: AdminScope; items: AdminSection[] };

/**
 * The Admin menu's entries the signed-in account may use, grouped by what
 * they reach. Each is there only for the role that may use it, so nobody is
 * shown a control the server would refuse.
 *
 * Admin holds only what the web gateway does not have yet, and each entry
 * goes once it does:
 * - Messaging apps: the workspace's side of its apps (replacing a token,
 *   the default app, confirming older links, guided set-up), for its admins.
 *   Your own accounts are linked in Settings.
 * - Connectors: the workspace's connector switches, for its admins, where
 *   the server has service connections on.
 * - Switch Trust: the deployment's guardrails, for the server's operator.
 * - Connector apps: the apps connectors sign in through, for the operator of
 *   a Switch that serves no gateway (one this Console runs without Docker),
 *   where the server has service connections on.
 *
 * The server's operator administers every workspace. A server's status is in
 * Settings. A group with nothing in it is left out.
 */
export function adminGroups(person: {
  administers: boolean;
  operator: boolean;
  operatesGatewaylessServer: boolean;
  serviceConnections: boolean;
}): AdminGroup[] {
  const { serviceConnections } = person;
  const groups: AdminGroup[] = [
    {
      scope: 'workspace',
      items: person.administers
        ? ['messaging-apps', ...(serviceConnections ? (['connectors'] as const) : [])]
        : [],
    },
    {
      scope: 'server',
      items: [
        ...(person.operator ? (['switch-trust'] as const) : []),
        ...(serviceConnections && person.operatesGatewaylessServer ? (['apps'] as const) : []),
      ],
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
