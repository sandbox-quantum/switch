import type { SettingsPageTab } from '@renderer/features/settings/settings-tabs';

/**
 * The sections the Admin page had, before its pages moved into Settings. A
 * switch-buddy link, a persisted navigation snapshot or an older button may
 * still name one, so each says which Settings tab it became.
 */
export type AdminSection = 'messaging-apps' | 'connectors' | 'decision' | 'switch-trust' | 'apps';

const SETTINGS_TAB_FOR: Record<AdminSection, SettingsPageTab> = {
  'messaging-apps': 'messaging-apps',
  connectors: 'connectors',
  decision: 'decision-routing',
  'switch-trust': 'guardrails',
  apps: 'connector-apps',
};

/**
 * The Settings params that open what an Admin link named: its section's tab,
 * and the connector app whose profile it opened. A section this build does not
 * know opens Settings on its first page, where the role-filtered menu offers
 * whatever the person may use.
 */
export function settingsForAdminSection(
  section: unknown,
  app?: unknown
): { tab: SettingsPageTab; app?: string } {
  const tab =
    typeof section === 'string' && Object.hasOwn(SETTINGS_TAB_FOR, section)
      ? SETTINGS_TAB_FOR[section as AdminSection]
      : 'preferences';
  return tab === 'connector-apps' && typeof app === 'string' ? { tab, app } : { tab };
}
