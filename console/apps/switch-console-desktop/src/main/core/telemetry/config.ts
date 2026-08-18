import { IS_CANARY } from '@shared/app-identity';

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
 * It is another product's hostname, written down in an open-source repository:
 * anyone reading this learns where the app reports to, which is a thing users
 * are entitled to know but was not ours to decide unilaterally. Adopted with
 * the collaborating dev's agreement, pending the product owner's.
 */
export const TELEMETRY_RELAY_ENDPOINT = 'https://telemetry.flintai.dev/v1/logs';

/** Which build sent an event, so a developer's app cannot pollute real numbers. */
export type TelemetryBuildChannel = 'dev' | 'canary' | 'stable';

export type TelemetryConfig = {
  endpoint: string;
  build: TelemetryBuildChannel;
};

/**
 * Why a build reports nothing. Only one reason now: the relay needs no key, so
 * there is no longer such a thing as a build that was configured wrongly.
 */
export type TelemetryDisabledReason = 'dev_build';

export type TelemetryResolution =
  | { enabled: true; config: TelemetryConfig }
  | { enabled: false; reason: TelemetryDisabledReason };

export function telemetryBuildChannel(): TelemetryBuildChannel {
  if (viteEnv?.DEV === true) return 'dev';
  return IS_CANARY ? 'canary' : 'stable';
}

/** Everything the decision depends on, so that it depends on nothing else. */
export type TelemetryEnvironment = {
  build: TelemetryBuildChannel;
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
  env,
}: TelemetryEnvironment): TelemetryResolution {
  const isDev = build === 'dev';
  if (isDev && env.SWITCHDASH_TELEMETRY_DEV !== '1') {
    return { enabled: false, reason: 'dev_build' };
  }

  const override = isDev ? env.SWITCHDASH_TELEMETRY_ENDPOINT?.trim() : undefined;
  return { enabled: true, config: { endpoint: override || TELEMETRY_RELAY_ENDPOINT, build } };
}

/** The same decision for the build that is actually running. */
export function resolveTelemetryConfig(): TelemetryResolution {
  return resolveTelemetryEnvironment({ build: telemetryBuildChannel(), env: process.env });
}
