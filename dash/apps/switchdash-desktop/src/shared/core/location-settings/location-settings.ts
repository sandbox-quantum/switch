import z from 'zod';

export const LOCATION_CONFIG_FILE = '.switchdash.json';

export const DEFAULT_PRESERVE_PATTERNS = [
  '.env',
  '.env.keys',
  '.env.local',
  '.env.*.local',
  '.envrc',
  'docker-compose.override.yml',
] as const;

const preservePatternsSchema = z
  .array(z.string())
  .transform((patterns) => patterns.filter((pattern) => pattern !== LOCATION_CONFIG_FILE));

export const shareableLocationScriptsSettingsSchema = z.object({
  setup: z.string().optional(),
  run: z.string().optional(),
  teardown: z.string().optional(),
});

export const shareableLocationSettingsSchema = z.object({
  preservePatterns: preservePatternsSchema.optional(),
  shellSetup: z.string().optional(),
  scripts: shareableLocationScriptsSettingsSchema.optional(),
});

export const shareableLocationSettingsWithDefaultsSchema = shareableLocationSettingsSchema.extend({
  preservePatterns: preservePatternsSchema.default([...DEFAULT_PRESERVE_PATTERNS]),
});

export type ShareableLocationSettings = z.infer<typeof shareableLocationSettingsSchema>;

export const baseLocationSettingsSchema = z.object({
  worktreeDirectory: z.string().trim().optional(),
  githubAccountId: z.string().trim().min(1).nullable().optional(),
  tmux: z.boolean().optional(),
  autoRunSetupScriptOnSessionCreation: z.boolean().optional(),
  autoRunRunScriptOnSessionCreation: z.boolean().optional(),
  workspaceProvider: z
    .object({
      type: z.literal('script'),
      provisionCommand: z.string().min(1),
      terminateCommand: z.string().min(1),
    })
    .optional(),
});

export type BaseLocationSettings = z.infer<typeof baseLocationSettingsSchema>;

export const legacyBaseLocationSettingsSchema = baseLocationSettingsSchema.extend({
  remote: z.string().optional(),
});

export const locationSettingsSchema = baseLocationSettingsSchema.merge(
  shareableLocationSettingsSchema
);

export const legacyLocationConfigSchema = legacyBaseLocationSettingsSchema.merge(
  shareableLocationSettingsSchema
);

export function defaultShareableLocationSettings(): ShareableLocationSettings {
  return shareableLocationSettingsWithDefaultsSchema.parse({});
}

export type LocationSettings = z.infer<typeof locationSettingsSchema>;

export type LocationSettingsPatch = {
  clearShareableFields?: ShareableLocationSettingsWriteField[];
  githubAccountId?: string | null;
};

export type LocationSettingsPage = {
  settings: LocationSettings;
  defaults: {
    worktreeDirectory: string;
  };
  writeTargets: LocationSettingsWriteTargetOption[];
  overrideState: LocationSettingsOverrideState;
  configMigrations: LocationConfigMigration[];
  shouldPromptConfigMigration: boolean;
};

export type LocationSettingsWriteTarget =
  | { type: 'location' }
  | { type: 'session'; sessionId: string }
  | { type: 'workspace'; locationId: string };

export type LocationSettingsWriteTargetOption = LocationSettingsWriteTarget & {
  label: string;
  path: string;
};

export type ShareableLocationSettingsWriteField =
  | 'preservePatterns'
  | 'shellSetup'
  | 'scripts.setup'
  | 'scripts.run'
  | 'scripts.teardown';

export const SHAREABLE_LOCATION_SETTINGS_WRITE_FIELDS = [
  'preservePatterns',
  'shellSetup',
  'scripts.setup',
  'scripts.run',
  'scripts.teardown',
] as const satisfies ShareableLocationSettingsWriteField[];

export type WriteLocationConfigRequest = {
  target: LocationSettingsWriteTarget;
  fields: ShareableLocationSettingsWriteField[];
};

export type LocationSettingsOverrideSource = {
  label: string;
  path: string;
  value: string;
};

export type LocationSettingsOverrideState = Record<
  ShareableLocationSettingsWriteField,
  LocationSettingsOverrideSource[]
>;

export type LocationConfigMigrationProvider = 'conductor' | 'superset' | 'paseo' | 'codex';

export type LocationConfigMigration = {
  provider: LocationConfigMigrationProvider;
  label: string;
  files: string[];
  fields: ShareableLocationSettingsWriteField[];
  unsupportedFields: string[];
};

export type LocationConfigMigrationDestination = 'local' | 'shared';

export type MigrateLocationConfigRequest = {
  provider: LocationConfigMigrationProvider;
  destination: LocationConfigMigrationDestination;
};

export type MigrateLocationConfigResult = {
  page: LocationSettingsPage;
  migration: LocationConfigMigration;
};

export function emptyLocationSettingsOverrideState(): LocationSettingsOverrideState {
  return {
    preservePatterns: [],
    shellSetup: [],
    'scripts.setup': [],
    'scripts.run': [],
    'scripts.teardown': [],
  };
}
