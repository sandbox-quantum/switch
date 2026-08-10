import type { ShortcutSettingsKey } from '@shared/shortcuts';

export interface CommandDef {
  id: string;
  label: string;
  description?: string;
  group?: string;
  scope: 'app' | 'location' | 'session' | 'session-sub';
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
    id: 'app.library',
    label: 'Open Library',
    description: 'Open the Library',
    scope: 'app',
    shortcutKey: 'library',
    group: 'App',
    iconKey: 'library',
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
    id: 'app.newSession',
    label: 'New Session',
    description: 'Spawn a new session for this agent',
    scope: 'app',
    shortcutKey: 'newSession',
    group: 'App',
    iconKey: 'square-plus',
  },
  {
    id: 'app.giveFeedback',
    label: 'Give Feedback',
    description: 'Send feedback to the Switch Console team',
    scope: 'app',
    group: 'App',
    iconKey: 'message-square-share',
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
    id: 'session.sidebarChanges',
    label: 'View Changes',
    description: 'Open the Changes panel in the right sidebar',
    scope: 'session',
    shortcutKey: 'sidebarChanges',
    group: 'View',
    iconKey: 'file-diff',
  },
  {
    id: 'session.sidebarFiles',
    label: 'View Files',
    description: 'Open the Files panel in the right sidebar',
    scope: 'session',
    shortcutKey: 'sidebarFiles',
    group: 'View',
    iconKey: 'folder-open',
  },
  {
    id: 'session.viewTerminals',
    label: 'View Terminals',
    description: 'Open the terminal drawer',
    scope: 'session',
    group: 'View',
    iconKey: 'terminal',
  },
  {
    id: 'session.toggleTerminalDrawer',
    label: 'Toggle Terminal Drawer',
    description: 'Show or hide the terminal drawer',
    scope: 'session',
    shortcutKey: 'toggleTerminalDrawer',
    group: 'Panel',
    iconKey: 'terminal',
  },
  {
    id: 'session.toggleRightSidebar',
    label: 'Toggle Right Sidebar',
    description: 'Show or hide the right sidebar',
    scope: 'session',
    shortcutKey: 'toggleRightSidebar',
    group: 'Panel',
    iconKey: 'panel-right',
  },
  {
    id: 'session.newTerminal',
    label: 'New Terminal',
    description: 'Create a new terminal session',
    scope: 'session',
    shortcutKey: 'newTerminal',
    group: 'Terminals',
    iconKey: 'square-terminal',
  },
  {
    id: 'session.openBrowser',
    label: 'Open Browser',
    description: 'Open an in-app browser for this session',
    scope: 'session',
    shortcutKey: 'openBrowser',
    group: 'Browser',
    iconKey: 'globe',
  },
  {
    id: 'session.browserGoBack',
    label: 'Browser Back',
    description: 'Go back in the active browser tab',
    scope: 'session',
    group: 'Browser',
    iconKey: 'arrow-left',
  },
  {
    id: 'session.browserGoForward',
    label: 'Browser Forward',
    description: 'Go forward in the active browser tab',
    scope: 'session',
    group: 'Browser',
    iconKey: 'arrow-right',
  },
  {
    id: 'session.browserReload',
    label: 'Reload Browser',
    description: 'Reload the active browser tab',
    scope: 'session',
    group: 'Browser',
    iconKey: 'refresh-cw',
  },
  {
    id: 'session.browserFocusUrl',
    label: 'Focus Browser URL',
    description: 'Focus the URL field in the active browser tab',
    scope: 'session',
    group: 'Browser',
    iconKey: 'text-cursor-input',
  },
  {
    id: 'session.browserOpenExternal',
    label: 'Open Browser URL Externally',
    description: 'Open the active browser URL in the system browser',
    scope: 'session',
    group: 'Browser',
    iconKey: 'external-link',
  },
  {
    id: 'session.browserCopyUrl',
    label: 'Copy Browser URL',
    description: 'Copy the active browser URL',
    scope: 'session',
    shortcutKey: 'browserCopyUrl',
    group: 'Browser',
    iconKey: 'copy',
  },
  {
    id: 'session.gitFetch',
    label: 'Git Fetch',
    description: 'Fetch latest changes from remote',
    scope: 'session',
    group: 'Git',
    iconKey: 'git-pull-request',
  },
  {
    id: 'session.gitPull',
    label: 'Git Pull',
    description: 'Pull latest changes from remote',
    scope: 'session',
    group: 'Git',
    iconKey: 'arrow-down-to-line',
  },
  {
    id: 'session.gitPush',
    label: 'Git Push',
    description: 'Push commits to remote',
    scope: 'session',
    group: 'Git',
    iconKey: 'arrow-up-to-line',
  },
  {
    id: 'session.pin',
    label: 'Pin Session',
    description: 'Pin this session to keep it at the top',
    scope: 'session',
    group: 'Session',
    iconKey: 'pin',
  },
  {
    id: 'session.convertAutomation',
    label: 'Convert to Regular Session',
    description: 'Detach this session from its automation run',
    scope: 'session',
    group: 'Session',
    iconKey: 'message-square',
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
