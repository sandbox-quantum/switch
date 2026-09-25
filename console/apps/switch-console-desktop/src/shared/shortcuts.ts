/**
 * APP_SHORTCUTS — central registry of keyboard shortcut metadata.
 *
 * `defaultHotkey` uses TanStack Hotkeys string format (e.g. 'Mod+K'), or a
 * factory function that is evaluated at call-time so defaults can vary by OS
 * or keyboard layout.
 */

export interface AppShortcutDef {
  defaultHotkey?: string | (() => string);
  label: string;
  description: string;
  category: string;
  conflictBehavior?: 'prevent' | 'allow';
  ignoreWhenMonacoFocused?: boolean;
}

export type TabNavigationDirection = 'next' | 'previous';

export const TAB_NAVIGATION_HOTKEYS = {
  next: 'Control+Tab',
  previous: 'Control+Shift+Tab',
} as const;

export interface DomTabNavigationInput {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface ElectronTabNavigationInput {
  type: string;
  key: string;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

function normalizeShortcutKey(key: string): string {
  return key.toLowerCase();
}

function resolveTabNavigationDirection(input: {
  type: string;
  key: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}): TabNavigationDirection | null {
  if (input.type !== 'keydown' && input.type !== 'keyDown') return null;
  if (normalizeShortcutKey(input.key) !== 'tab') return null;
  if (!input.control || input.alt || input.meta) return null;
  return input.shift ? 'previous' : 'next';
}

export function getDomTabNavigationDirection(
  input: DomTabNavigationInput
): TabNavigationDirection | null {
  return resolveTabNavigationDirection({
    type: input.type,
    key: input.key,
    control: input.ctrlKey,
    shift: input.shiftKey,
    alt: input.altKey,
    meta: input.metaKey,
  });
}

export function getElectronTabNavigationDirection(
  input: ElectronTabNavigationInput
): TabNavigationDirection | null {
  return resolveTabNavigationDirection({
    type: input.type,
    key: input.key,
    control: Boolean(input.control),
    shift: Boolean(input.shift),
    alt: Boolean(input.alt),
    meta: Boolean(input.meta),
  });
}

export function resolveDefaultHotkey(def: AppShortcutDef): string | undefined {
  return typeof def.defaultHotkey === 'function' ? def.defaultHotkey() : def.defaultHotkey;
}

function defineShortcuts<T extends Record<string, AppShortcutDef>>(
  shortcuts: T
): Record<keyof T, AppShortcutDef> {
  return shortcuts as Record<keyof T, AppShortcutDef>;
}

export const APP_SHORTCUTS = defineShortcuts({
  commandPalette: {
    defaultHotkey: 'Mod+K',
    label: 'Command Palette',
    description: 'Open the command palette to quickly search and navigate',
    category: 'Navigation',
  },
  settings: {
    defaultHotkey: 'Mod+,',
    label: 'Settings',
    description: 'Open application settings',
    category: 'Navigation',
  },
  toggleLeftSidebar: {
    defaultHotkey: 'Mod+B',
    label: 'Toggle Left Sidebar',
    description: 'Show or hide the left sidebar',
    category: 'View',
  },
  closeModal: {
    defaultHotkey: 'Escape',
    label: 'Close Modal',
    description: 'Close the current modal or dialog',
    category: 'Navigation',
  },
  deleteSelectedSessions: {
    defaultHotkey: 'Mod+Backspace',
    label: 'Delete Selected Sessions',
    description: 'Delete the selected sessions',
    category: 'Navigation',
  },
  newLocation: {
    defaultHotkey: 'Mod+Shift+N',
    label: 'New Location',
    description: 'Create a new location',
    category: 'Navigation',
  },
  openInEditor: {
    defaultHotkey: 'Mod+O',
    label: 'Open in Editor',
    description: 'Open the location in the default editor',
    category: 'Navigation',
  },
  sessionNext: {
    defaultHotkey: 'Mod+Alt+ArrowDown',
    label: 'Next Session',
    description: 'Switch to the next session',
    category: 'Session View',
    ignoreWhenMonacoFocused: true,
  },
  sessionPrev: {
    defaultHotkey: 'Mod+Alt+ArrowUp',
    label: 'Previous Session',
    description: 'Switch to the previous session',
    category: 'Session View',
    ignoreWhenMonacoFocused: true,
  },
  confirm: {
    defaultHotkey: 'Mod+Enter',
    label: 'Confirm',
    description: 'Confirm the current dialog action',
    category: 'Navigation',
  },
  saveChanges: {
    defaultHotkey: 'Mod+S',
    label: 'Save Changes',
    description: 'Save the unsaved edits on the current page',
    category: 'Navigation',
  },
  navigateBack: {
    defaultHotkey: 'Mod+[',
    label: 'Go Back',
    description: 'Navigate to the previous location',
    category: 'Navigation',
  },
  navigateForward: {
    defaultHotkey: 'Mod+]',
    label: 'Go Forward',
    description: 'Navigate to the next location',
    category: 'Navigation',
  },
});

export type ShortcutSettingsKey = keyof typeof APP_SHORTCUTS;
