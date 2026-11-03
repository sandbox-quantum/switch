import { IS_CANARY, IS_DEV, IS_RELEASE_BUILD } from '@shared/app-identity';

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
  // Hosted agents v2 (shared-cloud boxes): Core's single answer, `hosted_v2`. Off, or
  // absent from an older server, means Console shows v1 hosted exactly as upstream.
  'hosted_v2',
  'agent_management',
  'service_connections',
  'agent_chats',
  'switch_buddy',
  'group_chats',
  'buddy_slack_handoff',
] as const;

export type FeatureFlagKey = (typeof CONSOLE_FEATURE_FLAGS)[number];

export type FeatureFlags = Record<FeatureFlagKey, boolean>;

/** One flag as the gateway serves it. */
export type RemoteFeatureFlag = { key: string; enabled: boolean };

/** The `error` of a server whose flags have not been asked for yet, as opposed to failed. */
export const FLAGS_NOT_READ_YET = 'Not read yet';

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

/**
 * Whether a development run was asked to skip the first-run pages, with
 * `VITE_SKIP_FIRST_RUN=1` when the dev server starts. For test Consoles: the
 * first-run flow ends on Meet switch-buddy, which sets this computer up to run
 * agents as soon as it opens (B38), so a test account's sign-in would enrol the
 * test machine. A fresh install then opens the app itself, and a server is
 * added from Settings. Only a dev run reads it, and never a release build:
 * Vite's `DEV` follows the build mode, so a build made in development mode
 * would have it, and the release check makes the rule hold by design.
 */
export function skipsFirstRun(
  dev: boolean,
  release: boolean,
  env: { VITE_SKIP_FIRST_RUN?: string } | undefined
): boolean {
  return dev && !release && env?.VITE_SKIP_FIRST_RUN === '1';
}

const viteEnv = (import.meta as ImportMeta & { env?: { VITE_SKIP_FIRST_RUN?: string } }).env;

export const BUILD_FEATURE_FLAGS: BuildFeatureFlags = {
  onboarding: !skipsFirstRun(IS_DEV, IS_RELEASE_BUILD, viteEnv),
  switch_cloud: IS_DEV || IS_CANARY,
};
