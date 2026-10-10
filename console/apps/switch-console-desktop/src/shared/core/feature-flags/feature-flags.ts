import { IS_CANARY, IS_DEV } from '@shared/app-identity';

/**
 * Feature flags Console knows about. Each Switch server sets its own at deploy
 * time and serves them at `GET /gateway/feature-flags`; Console reads every
 * server it is connected to on a schedule, so a redeploy that turns a flag on
 * or off reaches a running Console without a restart.
 *
 * A key the server sends that is not listed here is ignored, and a key listed
 * here that the server does not send (an older server) is off.
 */
export const CONSOLE_FEATURE_FLAGS = [
  'ecosystem.show_owners',
  'switch_cloud',
  'hosted_agents',
  'agent_management',
] as const;

export type FeatureFlagKey = (typeof CONSOLE_FEATURE_FLAGS)[number];

export type FeatureFlags = Record<FeatureFlagKey, boolean>;

/** One flag as the gateway serves it. */
export type RemoteFeatureFlag = { key: string; enabled: boolean };

/** What Console last learned about one server's flags. */
export type ServerFeatureFlags = {
  serverId: string;
  flags: FeatureFlags;
  /** When the flags were last read successfully; null if they never were. */
  fetchedAt: number | null;
  /** Why the last read failed; null when it succeeded. `flags` then still
   * holds the last values read, or every flag off if none ever were. */
  error: string | null;
};

export function allFeatureFlagsOff(): FeatureFlags {
  return Object.fromEntries(CONSOLE_FEATURE_FLAGS.map((key) => [key, false])) as FeatureFlags;
}

export function resolveFeatureFlags(remote: readonly RemoteFeatureFlag[]): FeatureFlags {
  const flags = allFeatureFlagsOff();
  for (const { key, enabled } of remote) {
    if ((CONSOLE_FEATURE_FLAGS as readonly string[]).includes(key)) {
      flags[key as FeatureFlagKey] = enabled === true;
    }
  }
  return flags;
}

export function sameFeatureFlags(a: FeatureFlags, b: FeatureFlags): boolean {
  return CONSOLE_FEATURE_FLAGS.every((key) => a[key] === b[key]);
}

/**
 * What this build turns on before it has a server to ask.
 *
 * The first-run pages and the Switch Cloud choice are drawn before Console is
 * connected to anything, so no server's flags can decide them. A run from a
 * checkout and a canary have them on; a stable release has them off. Once
 * Console is connected, the server's own flags decide everything else.
 */
export type BuildFeatureFlags = {
  /** The first-run pages. Without them a fresh install opens the app itself. */
  onboarding: boolean;
  /** Switch Cloud as a place to connect to. It also needs the build's Cloud URL. */
  switch_cloud: boolean;
};

export const BUILD_FEATURE_FLAGS: BuildFeatureFlags = {
  onboarding: IS_DEV || IS_CANARY,
  switch_cloud: IS_DEV || IS_CANARY,
};
