import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BROWSER_PROFILE_ID, DEFAULT_BROWSER_PROFILES } from '@shared/browser';
import type { AppSettings, AppSettingsKey } from '@shared/core/app-settings';
import { TERMINAL_FONT_SIZE_DEFAULT } from '@shared/core/terminals/terminal-settings';
import { getDefaultLocalWorktreeDirectory } from './worktree-defaults';

export const DEFAULT_AGENT_ID = 'claude';

type SettingsDefaultsMap = {
  [K in AppSettingsKey]: AppSettings[K] | (() => AppSettings[K]);
};

export const SETTINGS_DEFAULTS = {
  location: {
    tmuxByDefault: false,
  },
  localLocation: () => ({
    defaultLocationsDirectory: join(homedir(), 'switchdash', 'repositories'),
    defaultWorktreeDirectory: getDefaultLocalWorktreeDirectory(),
    writeAgentConfigToGitIgnore: true,
  }),
  sessions: {
    autoGenerateName: true,
    autoTrustWorktrees: true,
    preserveNameCapitalization: false,
  },
  notifications: {
    enabled: true,
    sound: true,
    customSoundPath: '',
    soundFocusMode: 'always' as const,
  },
  terminal: {
    fontSize: TERMINAL_FONT_SIZE_DEFAULT,
    autoCopyOnSelection: false,
    macOptionIsMeta: false,
    defaultShell: 'system' as const,
  },
  theme: null,
  defaultAgent: DEFAULT_AGENT_ID,
  openIn: {
    default: 'terminal' as const,
  },
  interface: {
    sessionHoverAction: 'delete' as const,
    autoRightSidebarBehavior: false,
  },
  browserPreview: {
    enabled: true,
  },
  browser: {
    defaultProfileId: DEFAULT_BROWSER_PROFILE_ID,
    relaxCorsForLocalhost: false,
    profiles: DEFAULT_BROWSER_PROFILES,
  },
  remote: {
    maxAttachedSessionsPerHost: 4,
  },
  onboarding: {
    showChecklist: true,
  },
  changesViewMode: {
    unstaged: 'flat' as const,
    staged: 'flat' as const,
    pr: 'flat' as const,
  },
  telemetry: {
    enabled: true,
    askedAt: null,
  },
} satisfies SettingsDefaultsMap;

export function getDefaultForKey<K extends AppSettingsKey>(key: K): AppSettings[K] {
  const d = SETTINGS_DEFAULTS[key];
  return (typeof d === 'function' ? (d as () => AppSettings[K])() : d) as AppSettings[K];
}
