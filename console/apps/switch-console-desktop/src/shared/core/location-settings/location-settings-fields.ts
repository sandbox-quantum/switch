import {
  SHAREABLE_LOCATION_SETTINGS_WRITE_FIELDS,
  type ShareableLocationSettings,
  type ShareableLocationSettingsWriteField,
} from './location-settings';

type ShareableFieldAccessor = {
  get(settings: ShareableLocationSettings): unknown;
  set(settings: ShareableLocationSettings, value: unknown): void;
};

function ensureScripts(
  settings: ShareableLocationSettings
): NonNullable<ShareableLocationSettings['scripts']> {
  settings.scripts ??= {};
  return settings.scripts;
}

export const SHAREABLE_FIELD_ACCESSORS = {
  shellSetup: {
    get: (settings) => settings.shellSetup,
    set: (settings, value) => {
      settings.shellSetup = value as string | undefined;
    },
  },
  'scripts.setup': {
    get: (settings) => settings.scripts?.setup,
    set: (settings, value) => {
      ensureScripts(settings).setup = value as string | undefined;
    },
  },
  'scripts.run': {
    get: (settings) => settings.scripts?.run,
    set: (settings, value) => {
      ensureScripts(settings).run = value as string | undefined;
    },
  },
  'scripts.teardown': {
    get: (settings) => settings.scripts?.teardown,
    set: (settings, value) => {
      ensureScripts(settings).teardown = value as string | undefined;
    },
  },
} satisfies Record<ShareableLocationSettingsWriteField, ShareableFieldAccessor>;

export function mergeShareableLocationSettings(
  ...sources: ShareableLocationSettings[]
): ShareableLocationSettings {
  const next: ShareableLocationSettings = {};

  for (const source of sources) {
    for (const field of SHAREABLE_LOCATION_SETTINGS_WRITE_FIELDS) {
      const value = SHAREABLE_FIELD_ACCESSORS[field].get(source);
      if (value !== undefined) {
        SHAREABLE_FIELD_ACCESSORS[field].set(next, value);
      }
    }
  }

  return next;
}
