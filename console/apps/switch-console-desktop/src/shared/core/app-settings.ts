import type z from 'zod';
import {
  appSettingsSchema,
  type localLocationSettingsSchema,
  type notificationSettingsSchema,
  type providerCustomConfigEntrySchema,
  type sessionSettingsSchema,
  type telemetrySettingsSchema,
  type themeSchema,
} from '@main/core/settings/schema';

export type LocalLocationSettings = z.infer<typeof localLocationSettingsSchema>;
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;
export type TelemetrySettings = z.infer<typeof telemetrySettingsSchema>;
export type Theme = z.infer<typeof themeSchema>;

export type ProviderCustomConfig = z.infer<typeof providerCustomConfigEntrySchema>;
export type ProviderCustomConfigs = Record<string, ProviderCustomConfig>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type AppSettingsKey = keyof AppSettings;

export const AppSettingsKeys = Object.keys(appSettingsSchema.shape) as AppSettingsKey[];
