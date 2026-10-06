import z from 'zod';

export const LOCATION_CONFIG_FILE = '.switchdash.json';

export const shareableLocationScriptsSettingsSchema = z.object({
  setup: z.string().optional(),
  run: z.string().optional(),
  teardown: z.string().optional(),
});

export const shareableLocationSettingsSchema = z.object({
  shellSetup: z.string().optional(),
  scripts: shareableLocationScriptsSettingsSchema.optional(),
});

export type ShareableLocationSettings = z.infer<typeof shareableLocationSettingsSchema>;

export const baseLocationSettingsSchema = z.object({
  autoRunSetupScriptOnSessionCreation: z.boolean().optional(),
  autoRunRunScriptOnSessionCreation: z.boolean().optional(),
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

export type LocationSettings = z.infer<typeof locationSettingsSchema>;

export type LocationSettingsPage = {
  settings: LocationSettings;
};

export type ShareableLocationSettingsWriteField =
  | 'shellSetup'
  | 'scripts.setup'
  | 'scripts.run'
  | 'scripts.teardown';

export const SHAREABLE_LOCATION_SETTINGS_WRITE_FIELDS = [
  'shellSetup',
  'scripts.setup',
  'scripts.run',
  'scripts.teardown',
] as const satisfies ShareableLocationSettingsWriteField[];
