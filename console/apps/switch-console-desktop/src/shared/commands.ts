import type { ShortcutSettingsKey } from '@shared/shortcuts';

export interface CommandDef {
  id: string;
  label: string;
  description?: string;
  group?: string;
  scope: 'app' | 'session';
  shortcutKey?: ShortcutSettingsKey;
  /** Token resolved to a LucideIcon by the renderer's COMMAND_ICONS map. */
  iconKey?: string;
}

/**
 * Preserves literal tuple types for exhaustive ID unions while widening each
 * value to the full CommandDef interface.
 */
function defineCommandDefs<const T extends readonly CommandDef[]>(defs: T): T {
  return defs;
}

export const APP_COMMAND_DEFS = defineCommandDefs([
  {
    id: 'app.settings',
    label: 'Open Settings',
    description: 'Open application settings',
    scope: 'app',
    shortcutKey: 'settings',
    group: 'App',
    iconKey: 'settings',
  },
  {
    id: 'app.newLocation',
    label: 'Add Switch Agent',
    description: 'Onboard a local directory as a Switch agent — configuring one if needed',
    scope: 'app',
    shortcutKey: 'newLocation',
    group: 'App',
    iconKey: 'plus',
  },
  {
    id: 'app.addServer',
    label: 'Add Switch Server',
    description: 'Connect Switch Console to a Switch server, or run a managed one',
    scope: 'app',
    group: 'App',
    iconKey: 'server',
  },
  {
    id: 'app.toggleTheme',
    label: 'Toggle Theme',
    description: 'Switch between light and dark themes',
    scope: 'app',
    group: 'View',
    iconKey: 'palette',
  },
  {
    id: 'app.navigateBack',
    label: 'Go Back',
    description: 'Navigate to the previous location',
    scope: 'app',
    shortcutKey: 'navigateBack',
    group: 'Navigation',
    iconKey: 'arrow-left',
  },
  {
    id: 'app.navigateForward',
    label: 'Go Forward',
    description: 'Navigate to the next location',
    scope: 'app',
    shortcutKey: 'navigateForward',
    group: 'Navigation',
    iconKey: 'arrow-right',
  },
] as const);

export const SESSION_COMMAND_DEFS = defineCommandDefs([
  {
    id: 'session.pin',
    label: 'Pin Session',
    description: 'Pin this session to keep it at the top',
    scope: 'session',
    group: 'Session',
    iconKey: 'pin',
  },
  {
    id: 'session.nextSession',
    label: 'Next Session',
    description: 'Switch to the next session',
    scope: 'session',
    shortcutKey: 'sessionNext',
    group: 'Navigation',
    iconKey: 'chevron-down',
  },
  {
    id: 'session.prevSession',
    label: 'Previous Session',
    description: 'Switch to the previous session',
    scope: 'session',
    shortcutKey: 'sessionPrev',
    group: 'Navigation',
    iconKey: 'chevron-up',
  },
] as const);

export const ALL_COMMAND_DEFS = [...APP_COMMAND_DEFS, ...SESSION_COMMAND_DEFS] as const;

export type AppCommandId = (typeof APP_COMMAND_DEFS)[number]['id'];
export type SessionCommandId = (typeof SESSION_COMMAND_DEFS)[number]['id'];
export type CommandId = (typeof ALL_COMMAND_DEFS)[number]['id'];
