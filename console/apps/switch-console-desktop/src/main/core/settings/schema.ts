import z from 'zod';
import { BROWSER_ISOLATED_PROFILE_ID } from '@shared/browser';
import { AGENT_PROVIDER_IDS } from '@shared/core/providers/agent-provider-registry';
import type { AppSettingsKeyName } from '@shared/core/settings/setting-keys';
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_SHELL_IDS,
} from '@shared/core/terminals/terminal-settings';
import { openInAppIdSchema } from '@shared/openInApps';
import { DEFAULT_AGENT_ID } from './settings-registry';

export const locationSettingsSchema = z.object({
  tmuxByDefault: z.boolean(),
});

export const localLocationSettingsSchema = z.object({
  defaultLocationsDirectory: z.string(),
  defaultWorktreeDirectory: z.string(),
  writeAgentConfigToGitIgnore: z.boolean(),
});

export const notificationSettingsSchema = z.object({
  enabled: z.boolean(),
  sound: z.boolean(),
  customSoundPath: z.string(),
  soundFocusMode: z.enum(['always', 'unfocused']),
});

export const sessionSettingsSchema = z.object({
  autoGenerateName: z.boolean(),
  autoTrustWorktrees: z.boolean(),
  preserveNameCapitalization: z.boolean(),
});

export const terminalSettingsSchema = z.object({
  fontFamily: z.string().optional(),
  fontSize: z.number().min(TERMINAL_FONT_SIZE_MIN).max(TERMINAL_FONT_SIZE_MAX).optional(),
  autoCopyOnSelection: z.boolean(),
  macOptionIsMeta: z.boolean(),
  defaultShell: z.enum(TERMINAL_SHELL_IDS),
});

export const themeSchema = z
  .enum(['emlight', 'emdark'])
  .nullable()
  .catch(null)
  .optional()
  .default(null);

export const defaultAgentSchema = z.optional(z.enum(AGENT_PROVIDER_IDS)).default(DEFAULT_AGENT_ID);

/**
 * Per-provider execution settings stored as host-agnostic overrides.
 * Installation source/path/cli overrides are now stored host-specifically
 * in the HostDependencyStore (KV for local, SSH connection metadata for remote).
 */
export const providerCustomConfigEntrySchema = z.object({
  extraArgs: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const providerConfigDefaults: Record<string, unknown> = {};

export const interfaceSettingsSchema = z.object({
  sessionHoverAction: z.enum(['delete', 'archive']),
  autoRightSidebarBehavior: z.boolean(),
});

export const changesViewModeSchema = z.object({
  unstaged: z.enum(['flat', 'tree']),
  staged: z.enum(['flat', 'tree']),
  pr: z.enum(['flat', 'tree']),
});

export const browserPreviewSettingsSchema = z.object({ enabled: z.boolean() });

export const browserProfileIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
  .refine((value) => value !== BROWSER_ISOLATED_PROFILE_ID);

export const browserSettingsSchema = z
  .object({
    defaultProfileId: z.union([browserProfileIdSchema, z.literal(BROWSER_ISOLATED_PROFILE_ID)]),
    relaxCorsForLocalhost: z.boolean(),
    profiles: z
      .array(
        z.object({
          id: browserProfileIdSchema,
          name: z.string().trim().min(1).max(40),
        })
      )
      .min(1),
  })
  .refine(
    (settings) =>
      new Set(settings.profiles.map((profile) => profile.id)).size === settings.profiles.length
  )
  .refine(
    (settings) =>
      settings.defaultProfileId === BROWSER_ISOLATED_PROFILE_ID ||
      settings.profiles.some((profile) => profile.id === settings.defaultProfileId)
  );

/**
 * Whether the user lets the app send anonymous usage data, and when they were
 * asked.
 *
 * `askedAt` is null until the user has answered the first-run prompt, and is
 * what distinguishes "hasn't been asked yet" from "was asked and left it on".
 * Nothing may be sent while it is null, however `enabled` reads — see
 * `isTelemetryAllowed` in `@main/core/telemetry/consent`, which is the only
 * supported way to read this setting before emitting.
 */
export const telemetrySettingsSchema = z.object({
  enabled: z.boolean(),
  askedAt: z.number().nullable(),
});

/**
 * How many sessions on one remote host keep a live terminal at once.
 *
 * Every session on a host shares a single SSH transport, and an attached
 * terminal holds a channel on it for as long as it is attached. Past a handful,
 * a slow tunnel (an IAP or SSM ProxyCommand) stops answering channel opens and
 * the transport is torn down and rebuilt in a loop. Detaching costs nothing
 * real: the agent keeps running in its tmux pane on the VM and keeps reporting
 * status, so this bounds a display concern, not the work.
 */
export const remoteSettingsSchema = z.object({
  maxAttachedSessionsPerHost: z.number().int().min(1).max(64),
});

export const openInSettingsSchema = z.object({
  default: openInAppIdSchema,
});

/**
 * Whether the first-run setup checklist is shown (CHOO-2022).
 *
 * Dismissing the checklist with its ✕ clears this, and the Settings toggle is
 * the way back — a dismissal that could not be undone would make the checklist
 * a one-shot, which is the wrong shape for something a user may dismiss before
 * they know what it was.
 */
export const onboardingSettingsSchema = z.object({
  showChecklist: z.boolean(),
  /**
   * When finishing the checklist was reported, or null.
   *
   * Completion is derived from what the app can see — a server exists, a room
   * exists — so it is a condition rather than a moment: true on every render
   * once it holds, and true again on every later launch. Without somewhere to
   * remember that it has been reported, "finished onboarding" would be counted
   * once per start-up for the rest of the install's life.
   */
  completedReportedAt: z.number().nullable(),
});

export const APP_SETTINGS_SCHEMA_MAP = {
  localLocation: localLocationSettingsSchema,
  location: locationSettingsSchema,
  sessions: sessionSettingsSchema,
  defaultAgent: defaultAgentSchema,
  notifications: notificationSettingsSchema,
  theme: themeSchema,
  openIn: openInSettingsSchema,
  interface: interfaceSettingsSchema,
  terminal: terminalSettingsSchema,
  browserPreview: browserPreviewSettingsSchema,
  browser: browserSettingsSchema,
  changesViewMode: changesViewModeSchema,
  remote: remoteSettingsSchema,
  onboarding: onboardingSettingsSchema,
  telemetry: telemetrySettingsSchema,
} as const;

/**
 * The schema map and the shared list of setting names say the same thing.
 *
 * The list is what a setting change is reported against and cannot import this
 * file. Asserted both ways, so adding a group without naming it there — or
 * leaving a name behind after removing one — fails to compile.
 */
const _settingKeysAreExhaustive: AppSettingsKeyName extends keyof typeof APP_SETTINGS_SCHEMA_MAP
  ? true
  : never = true;
const _settingKeysAreComplete: keyof typeof APP_SETTINGS_SCHEMA_MAP extends AppSettingsKeyName
  ? true
  : never = true;
void _settingKeysAreExhaustive;
void _settingKeysAreComplete;

export const appSettingsSchema = z.object({
  localLocation: localLocationSettingsSchema,
  location: locationSettingsSchema,
  sessions: sessionSettingsSchema,
  defaultAgent: defaultAgentSchema,
  notifications: notificationSettingsSchema,
  theme: themeSchema,
  openIn: openInSettingsSchema,
  interface: interfaceSettingsSchema,
  terminal: terminalSettingsSchema,
  browserPreview: browserPreviewSettingsSchema,
  browser: browserSettingsSchema,
  changesViewMode: changesViewModeSchema,
  remote: remoteSettingsSchema,
  onboarding: onboardingSettingsSchema,
  telemetry: telemetrySettingsSchema,
});
