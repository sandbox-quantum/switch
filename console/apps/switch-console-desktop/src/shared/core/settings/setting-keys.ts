/**
 * The names of the app's settings groups.
 *
 * Written out rather than derived from the schema map, because this list is
 * what a setting change is reported against and it must be a closed set of
 * literals — a type derived from a `Record` widens to `string` at the boundary
 * the value crosses, and a `string` in a payload is exactly what the catalogue
 * exists to prevent.
 *
 * The schema map asserts at compile time that it and this list agree, so adding
 * a settings group without naming it here fails the build.
 */
export const APP_SETTINGS_KEYS = [
  'localLocation',
  'location',
  'sessions',
  'defaultAgent',
  'notifications',
  'theme',
  'openIn',
  'interface',
  'terminal',
  'browserPreview',
  'browser',
  'changesViewMode',
  'remote',
  'onboarding',
  'telemetry',
] as const;

export type AppSettingsKeyName = (typeof APP_SETTINGS_KEYS)[number];
