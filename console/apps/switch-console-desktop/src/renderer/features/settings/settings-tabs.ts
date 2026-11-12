/**
 * Settings' sections, and who sees which.
 *
 * Settings is about this person and this computer, so most of it is the same
 * for everyone. What changes is what needs a server (your messaging accounts,
 * keys and account live on one), what needs agent management, and whether the
 * server serves the web gateway that its workspace and organization settings
 * live in.
 */

export type SettingsPageTab =
  | 'preferences'
  | 'messaging-apps'
  | 'clis-models'
  | 'api-keys'
  | 'devices'
  | 'remote-hosts'
  | 'managed-agents'
  | 'status'
  | 'account';

/** Links out of Settings: they open somewhere else rather than a pane. */
export type SettingsLink = 'workspace-settings' | 'organization-settings' | 'docs';

export type SettingsItemId = SettingsPageTab | SettingsLink;

export type SettingsItem = { id: SettingsItemId; label: string; isExternal?: boolean };

export const SETTINGS_TABS: readonly SettingsPageTab[] = [
  'preferences',
  'messaging-apps',
  'clis-models',
  'api-keys',
  'devices',
  'remote-hosts',
  'managed-agents',
  'status',
  'account',
];

/**
 * Tabs Settings had before, and where each went. A link from an older
 * switch-buddy, a persisted navigation snapshot or an update notice may still
 * name one.
 */
export const FORMER_SETTINGS_TABS: Readonly<Record<string, SettingsPageTab>> = {
  general: 'preferences',
  interface: 'preferences',
};

export function resolveSettingsTab(tab: unknown): SettingsPageTab {
  if (typeof tab !== 'string') return 'preferences';
  if ((SETTINGS_TABS as readonly string[]).includes(tab)) return tab as SettingsPageTab;
  return Object.hasOwn(FORMER_SETTINGS_TABS, tab) ? FORMER_SETTINGS_TABS[tab]! : 'preferences';
}

export type SettingsAudience = {
  /** A server is active, so there is an account, keys and messaging apps to show. */
  hasServer: boolean;
  /** Some server runs agent management, so there is something to move to managed. */
  agentManagement: boolean;
  /** The active server serves the web gateway, and you are signed in to it. */
  workspaceSettings: boolean;
  /** As `workspaceSettings`, and you administer the workspace's organization. */
  organizationSettings: boolean;
};

/**
 * The sidebar's sections, in order: this computer and your work, then your
 * account, then the ways out. The workspace's own settings are the gateway's,
 * open to every member there; the organization's are the gateway's too, offered
 * to the organization's admins, who are the ones who can change them.
 */
export function settingsSections(audience: SettingsAudience): SettingsItem[][] {
  const main: SettingsItem[] = [
    { id: 'preferences', label: 'Preferences' },
    ...(audience.hasServer ? [{ id: 'messaging-apps' as const, label: 'Messaging apps' }] : []),
    { id: 'clis-models', label: 'Agent providers' },
    ...(audience.hasServer ? [{ id: 'api-keys' as const, label: 'API keys' }] : []),
    // The devices Switch knows are yours exist only where agent management runs.
    ...(audience.agentManagement ? [{ id: 'devices' as const, label: 'Your devices' }] : []),
    // The SSH hosts this Console reaches are this computer's own list.
    { id: 'remote-hosts', label: 'Remote hosts' },
    ...(audience.agentManagement
      ? [{ id: 'managed-agents' as const, label: 'Managed agents' }]
      : []),
    { id: 'status', label: 'System status' },
  ];
  const account: SettingsItem[] = audience.hasServer
    ? [{ id: 'account', label: 'Your account' }]
    : [];
  const links: SettingsItem[] = [
    ...(audience.workspaceSettings
      ? [{ id: 'workspace-settings' as const, label: 'Workspace settings', isExternal: true }]
      : []),
    ...(audience.organizationSettings
      ? [{ id: 'organization-settings' as const, label: 'Organization settings', isExternal: true }]
      : []),
    { id: 'docs', label: 'Docs', isExternal: true },
  ];
  return [main, account, links];
}

/**
 * The tab to show: the one asked for while the sidebar offers it, else
 * Preferences, so a tab that went away (a server signed out of, agent
 * management turned off) never leaves an empty pane.
 */
export function shownSettingsTab(
  tab: SettingsPageTab,
  sections: readonly (readonly SettingsItem[])[]
): SettingsPageTab {
  return sections.some((items) => items.some((item) => item.id === tab)) ? tab : 'preferences';
}
