import type z from 'zod';
import {
  appSettingsSchema,
  type agentAutoApproveDefaultsSchema,
  type browserSettingsSchema,
  type changesViewModeSchema,
  type interfaceSettingsSchema,
  type localLocationSettingsSchema,
  type notificationSettingsSchema,
  type locationSettingsSchema,
  type providerCustomConfigEntrySchema,
  type sessionSettingsSchema,
  type terminalSettingsSchema,
  type themeSchema,
} from '@main/core/settings/schema';

export type LocalLocationSettings = z.infer<typeof localLocationSettingsSchema>;
export type LocationSettings = z.infer<typeof locationSettingsSchema>;
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;
export type AgentAutoApproveDefaults = z.infer<typeof agentAutoApproveDefaultsSchema>;
export type TerminalSettings = z.infer<typeof terminalSettingsSchema>;
export type Theme = z.infer<typeof themeSchema>;

export type InterfaceSettings = z.infer<typeof interfaceSettingsSchema>;
export type ProviderCustomConfig = z.infer<typeof providerCustomConfigEntrySchema>;
export type ProviderCustomConfigs = Record<string, ProviderCustomConfig>;
export type ChangesViewMode = z.infer<typeof changesViewModeSchema>;
export type BrowserSettings = z.infer<typeof browserSettingsSchema>;
export type ChangesSection = keyof ChangesViewMode;
export type ChangesListViewMode = ChangesViewMode[ChangesSection];
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type AppSettingsKey = keyof AppSettings;

export const AppSettingsKeys = Object.keys(appSettingsSchema.shape) as AppSettingsKey[];
