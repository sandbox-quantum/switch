export type AdminSection = 'connectors' | 'apps';

export type AdminScope = 'workspace' | 'server';

export const ADMIN_SECTION_LABELS = {
  connectors: 'Connectors',
  apps: 'Connector apps',
} as const satisfies Record<AdminSection, string>;

export type AdminGroup = { scope: AdminScope; sections: AdminSection[] };

/**
 * The Admin page's sections the signed-in account may use, grouped by what
 * they reach. Each is there only for the role that may use it, so nobody is
 * shown a control the server would refuse: the workspace's connector
 * switches are its admins' (the server's operator administers every
 * workspace), and the apps connectors sign in through are the operator's
 * alone. A group with nothing in it is left out.
 */
export function adminGroups(person: { administers: boolean; operator: boolean }): AdminGroup[] {
  const groups: AdminGroup[] = [
    { scope: 'workspace', sections: person.administers ? ['connectors'] : [] },
    { scope: 'server', sections: person.operator ? ['apps'] : [] },
  ];
  return groups.filter((group) => group.sections.length > 0);
}

/**
 * The section to show: the one asked for when the person may use it,
 * otherwise the first they may. Null when they may use none.
 */
export function shownAdminSection(
  groups: AdminGroup[],
  asked: AdminSection | undefined
): AdminSection | null {
  const sections = groups.flatMap((group) => group.sections);
  if (asked !== undefined && sections.includes(asked)) return asked;
  return sections[0] ?? null;
}
