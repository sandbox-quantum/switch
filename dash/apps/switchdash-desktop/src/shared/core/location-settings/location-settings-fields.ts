import {
  DEFAULT_PRESERVE_PATTERNS,
  SHAREABLE_LOCATION_SETTINGS_WRITE_FIELDS,
  type LocationSettings,
  type ShareableLocationSettings,
  type ShareableLocationSettingsWriteField,
} from './location-settings';

type ShareableFieldAccessor = {
  path: string[];
  get(settings: ShareableLocationSettings): unknown;
  set(settings: ShareableLocationSettings, value: unknown): void;
  clear(settings: ShareableLocationSettings): void;
  displayValue(settings: ShareableLocationSettings): string | null;
};

function ensureScripts(
  settings: ShareableLocationSettings
): NonNullable<ShareableLocationSettings['scripts']> {
  settings.scripts ??= {};
  return settings.scripts;
}

function displayText(value: string | undefined): string | null {
  return value?.trim() ? value : null;
}

function compactScripts(settings: ShareableLocationSettings): void {
  if (settings.scripts && Object.values(settings.scripts).every((value) => value === undefined)) {
    delete settings.scripts;
  }
}

function normalizePatterns(patterns: string[] | undefined): string[] {
  return patterns?.map((pattern) => pattern.trim()).filter(Boolean) ?? [];
}

export function hasDefaultPreservePatterns(settings: ShareableLocationSettings): boolean {
  const patterns = normalizePatterns(settings.preservePatterns);
  if (patterns.length !== DEFAULT_PRESERVE_PATTERNS.length) return false;
  const patternSet = new Set(patterns);
  return DEFAULT_PRESERVE_PATTERNS.every((pattern) => patternSet.has(pattern));
}

export function hasConfiguredShareableProjectSettings(settings: LocationSettings): boolean {
  return SHAREABLE_LOCATION_SETTINGS_WRITE_FIELDS.some((field) => {
    if (field === 'preservePatterns') {
      const patterns = normalizePatterns(settings.preservePatterns);
      return patterns.length > 0 && !hasDefaultPreservePatterns(settings);
    }
    return SHAREABLE_FIELD_ACCESSORS[field].displayValue(settings) !== null;
  });
}

export const SHAREABLE_FIELD_ACCESSORS = {
  preservePatterns: {
    path: ['preservePatterns'],
    get: (settings) => settings.preservePatterns,
    set: (settings, value) => {
      settings.preservePatterns = value as string[] | undefined;
    },
    clear: (settings) => {
      delete settings.preservePatterns;
    },
    displayValue: (settings) => {
      const value = normalizePatterns(settings.preservePatterns);
      return value?.length ? value.join('\n') : null;
    },
  },
  shellSetup: {
    path: ['shellSetup'],
    get: (settings) => settings.shellSetup,
    set: (settings, value) => {
      settings.shellSetup = value as string | undefined;
    },
    clear: (settings) => {
      delete settings.shellSetup;
    },
    displayValue: (settings) => displayText(settings.shellSetup),
  },
  'scripts.setup': {
    path: ['scripts', 'setup'],
    get: (settings) => settings.scripts?.setup,
    set: (settings, value) => {
      ensureScripts(settings).setup = value as string | undefined;
    },
    clear: (settings) => {
      if (settings.scripts) delete settings.scripts.setup;
      compactScripts(settings);
    },
    displayValue: (settings) => displayText(settings.scripts?.setup),
  },
  'scripts.run': {
    path: ['scripts', 'run'],
    get: (settings) => settings.scripts?.run,
    set: (settings, value) => {
      ensureScripts(settings).run = value as string | undefined;
    },
    clear: (settings) => {
      if (settings.scripts) delete settings.scripts.run;
      compactScripts(settings);
    },
    displayValue: (settings) => displayText(settings.scripts?.run),
  },
  'scripts.teardown': {
    path: ['scripts', 'teardown'],
    get: (settings) => settings.scripts?.teardown,
    set: (settings, value) => {
      ensureScripts(settings).teardown = value as string | undefined;
    },
    clear: (settings) => {
      if (settings.scripts) delete settings.scripts.teardown;
      compactScripts(settings);
    },
    displayValue: (settings) => displayText(settings.scripts?.teardown),
  },
} satisfies Record<ShareableLocationSettingsWriteField, ShareableFieldAccessor>;

export function clearShareableProjectSettingsFields<T extends LocationSettings>(
  settings: T,
  fields: ShareableLocationSettingsWriteField[]
): T {
  const next: LocationSettings = {
    ...settings,
    preservePatterns: settings.preservePatterns ? [...settings.preservePatterns] : undefined,
    scripts: settings.scripts ? { ...settings.scripts } : undefined,
  };

  for (const field of fields) {
    SHAREABLE_FIELD_ACCESSORS[field].clear(next);
  }

  return next as T;
}

export function mergeShareableProjectSettings(
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
