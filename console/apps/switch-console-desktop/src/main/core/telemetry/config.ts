import { IS_CANARY, IS_RELEASE_BUILD } from '@shared/app-identity';

type ImportMetaWithEnv = ImportMeta & { env?: { DEV?: boolean } };

const viteEnv = (import.meta as ImportMetaWithEnv).env;

/**
 * The company's public OTLP relay, which forwards to Amplitude and Datadog.
 *
 * It holds both vendor keys server-side, which is the whole reason to use it. A
 * desktop app cannot keep a credential — anything compiled into it ships to
 * every user and can be read straight back out — so this way nothing of ours is
 * in the binary at all, and no build needs configuring to report.
 *
 * Unauthenticated by design, and guarded by requiring a client id instead: see
 * `./relay-client`. Public rather than internal — the same endpoint a public
 * GitHub Action posts to from a customer's CI.
 *
 * The hostname is written down in an open-source repository on purpose: anyone
 * reading this learns where the app reports to, which users are entitled to
 * know.
 */
export const TELEMETRY_RELAY_ORIGIN = 'https://telemetry.switchagents.ai';
export const TELEMETRY_RELAY_ENDPOINT = `${TELEMETRY_RELAY_ORIGIN}/v1/logs`;

/** Which build sent an event, so a developer's app cannot pollute real numbers. */
export type TelemetryBuildChannel = 'dev' | 'canary' | 'stable';

export type TelemetryConfig = {
  endpoint: string;
  build: TelemetryBuildChannel;
  flintEnv: TelemetryFlintEnv;
};

/**
 * Why a build reports nothing. Only one reason now: the relay needs no key, so
 * there is no longer such a thing as a build that was configured wrongly.
 */
export type TelemetryDisabledReason = 'dev_build';

export type TelemetryResolution =
  | { enabled: true; config: TelemetryConfig }
  | { enabled: false; reason: TelemetryDisabledReason };

/**
 * The Amplitude project an event belongs in, sent as the `flint_env` resource
 * attribute. The relay keeps one project per environment and files each event
 * under the one this names, so a developer's app and a pre-release never land
 * in production's numbers. `build` stays on every event besides, for slicing
 * within a project.
 */
export type TelemetryFlintEnv = 'prod' | 'staging' | 'dev' | 'local';

/**
 * Running from source is `local`. A packaged build that is not a release — a
 * workflow_dispatch test build, or one packaged on a laptop — is `dev`, whatever
 * channel it was built as. Only a released canary is `staging`, and only a
 * released stable build is `prod`.
 */
export function flintEnvFor({
  build,
  release,
}: {
  build: TelemetryBuildChannel;
  release: boolean;
}): TelemetryFlintEnv {
  if (build === 'dev') return 'local';
  if (!release) return 'dev';
  return build === 'canary' ? 'staging' : 'prod';
}

/** The project for the build that is actually running. */
export function currentFlintEnv(): TelemetryFlintEnv {
  return flintEnvFor({ build: telemetryBuildChannel(), release: IS_RELEASE_BUILD });
}

export function telemetryBuildChannel(): TelemetryBuildChannel {
  if (viteEnv?.DEV === true) return 'dev';
  return IS_CANARY ? 'canary' : 'stable';
}

/** Everything the decision depends on, so that it depends on nothing else. */
export type TelemetryEnvironment = {
  build: TelemetryBuildChannel;
  /** Whether the release workflow stamped this build as a published release. */
  release: boolean;
  env: NodeJS.ProcessEnv;
};

/**
 * Whether this build can send at all, before any question of consent.
 *
 * Taken as an argument rather than read from the ambient environment, because
 * `import.meta.env.DEV` is replaced at build time: a test cannot become a
 * packaged build, and the rules that apply only to one are exactly the rules
 * worth proving.
 *
 * A dev run sends nothing unless `SWITCHDASH_TELEMETRY_DEV=1`, mirroring how the
 * updater stays inert outside packaged builds. With it set, a dev run can be
 * pointed elsewhere with `SWITCHDASH_TELEMETRY_ENDPOINT` — at a local listener
 * to read what it sends, or at a relay running locally. Dev-only: a shipped
 * build reports to the relay or not at all, so nothing able to set a variable
 * before launch can redirect a consenting user's events somewhere else.
 */
export function resolveTelemetryEnvironment({
  build,
  release,
  env,
}: TelemetryEnvironment): TelemetryResolution {
  const isDev = build === 'dev';
  if (isDev && env.SWITCHDASH_TELEMETRY_DEV !== '1') {
    return { enabled: false, reason: 'dev_build' };
  }

  const override = isDev ? env.SWITCHDASH_TELEMETRY_ENDPOINT?.trim() : undefined;
  return {
    enabled: true,
    config: {
      endpoint: override || TELEMETRY_RELAY_ENDPOINT,
      build,
      flintEnv: flintEnvFor({ build, release }),
    },
  };
}

/** The same decision for the build that is actually running. */
export function resolveTelemetryConfig(): TelemetryResolution {
  return resolveTelemetryEnvironment({
    build: telemetryBuildChannel(),
    release: IS_RELEASE_BUILD,
    env: process.env,
  });
}

/**
 * Where a Switch server this app runs sends its own usage: wherever this app
 * sends its own, so the two are always one pipeline whatever server version
 * is pinned, and a dev run pointed at a local listener sees both halves.
 *
 * An origin, because switch-core appends the signal path itself and refuses a
 * value that already carries one. A build that sends nothing still names the
 * relay: whether the server reports is the consent gate's to decide, not this.
 */
export function managedServerTelemetryEndpointFor(resolution: TelemetryResolution): string {
  return resolution.enabled ? new URL(resolution.config.endpoint).origin : TELEMETRY_RELAY_ORIGIN;
}

/** The same, for the build that is actually running. */
export function managedServerTelemetryEndpoint(): string {
  return managedServerTelemetryEndpointFor(resolveTelemetryConfig());
}
