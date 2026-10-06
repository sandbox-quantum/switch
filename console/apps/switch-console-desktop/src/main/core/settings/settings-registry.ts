import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppSettings, AppSettingsKey } from '@shared/core/app-settings';

export const DEFAULT_AGENT_ID = 'claude';

type SettingsDefaultsMap = {
  [K in AppSettingsKey]: AppSettings[K] | (() => AppSettings[K]);
};

export const SETTINGS_DEFAULTS = {
  localLocation: () => ({
    defaultLocationsDirectory: join(homedir(), '.switch', 'agents'),
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
  theme: null,
  defaultAgent: DEFAULT_AGENT_ID,
  openIn: {
    default: 'terminal' as const,
  },
  onboarding: {
    showChecklist: true,
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
