import { IS_CANARY } from '@shared/app-identity';

type ImportMetaWithEnv = ImportMeta & {
  env?: { DEV?: boolean; MAIN_VITE_AMPLITUDE_API_KEY?: string };
};

const viteEnv = (import.meta as ImportMetaWithEnv).env;

/**
 * Amplitude's US ingestion endpoint. The EU one (`api.eu.amplitude.com`) serves
 * a different Amplitude organisation, so this is not a preference — it has to
 * match the project the key belongs to.
 */
export const AMPLITUDE_US_ENDPOINT = 'https://api2.amplitude.com/2/httpapi';

/** Which build sent an event, so a developer's app cannot pollute real numbers. */
export type TelemetryBuildChannel = 'dev' | 'canary' | 'stable';

export type TelemetryConfig = {
  apiKey: string;
  endpoint: string;
  build: TelemetryBuildChannel;
};

/**
 * Why a build reports nothing. Both are ordinary states, not faults: a dev run,
 * and a build made without a key.
 */
export type TelemetryDisabledReason = 'dev_build' | 'no_api_key';

export type TelemetryResolution =
  | { enabled: true; config: TelemetryConfig }
  | { enabled: false; reason: TelemetryDisabledReason };

export function telemetryBuildChannel(): TelemetryBuildChannel {
  if (viteEnv?.DEV === true) return 'dev';
  return IS_CANARY ? 'canary' : 'stable';
}

/**
 * Everything the decision depends on, so that it depends on nothing else.
 *
 * Of the environment it reads `SWITCHDASH_TELEMETRY_DEV`,
 * `SWITCHDASH_TELEMETRY_ENDPOINT` and `MAIN_VITE_AMPLITUDE_API_KEY`, and only in
 * a dev run.
 */
export type TelemetryEnvironment = {
  build: TelemetryBuildChannel;
  /** The key compiled into this build, if it was built with one. */
  bakedKey: string | undefined;
  env: NodeJS.ProcessEnv;
};

/**
 * Whether this build can send at all, before any question of consent.
 *
 * Taken as an argument rather than read from the ambient environment, because
 * `import.meta.env.DEV` is replaced at build time: a test cannot become a
 * packaged build, and the rules that only apply to one are exactly the rules
 * worth proving.
 *
 * The environment is consulted only in a dev run. A shipped build sends with
 * the key it was built with or sends nothing at all — otherwise anything able
 * to set a variable before launch could point a consenting user's events at its
 * own Amplitude project, and a build documented as inert would not be.
 */
export function resolveTelemetryEnvironment({
  build,
  bakedKey,
  env,
}: TelemetryEnvironment): TelemetryResolution {
  const isDev = build === 'dev';
  if (isDev && env.SWITCHDASH_TELEMETRY_DEV !== '1') {
    return { enabled: false, reason: 'dev_build' };
  }

  const apiKey = (bakedKey ?? (isDev ? env.MAIN_VITE_AMPLITUDE_API_KEY : undefined) ?? '').trim();
  if (!apiKey) return { enabled: false, reason: 'no_api_key' };

  const override = isDev ? env.SWITCHDASH_TELEMETRY_ENDPOINT?.trim() : undefined;
  return { enabled: true, config: { apiKey, endpoint: override || AMPLITUDE_US_ENDPOINT, build } };
}

/**
 * The same decision for the build that is actually running.
 *
 * The key is baked in at build time from `MAIN_VITE_AMPLITUDE_API_KEY`, so it
 * reaches only the main bundle and never the renderer. A build made without one
 * is inert — the expected state of a local `pnpm run package` — and says so
 * once rather than failing or retrying.
 */
export function resolveTelemetryConfig(): TelemetryResolution {
  return resolveTelemetryEnvironment({
    build: telemetryBuildChannel(),
    bakedKey: viteEnv?.MAIN_VITE_AMPLITUDE_API_KEY,
    env: process.env,
  });
}
