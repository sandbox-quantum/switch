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
 * Whether this build can send at all, before any question of consent.
 *
 * The key is baked in at build time from `MAIN_VITE_AMPLITUDE_API_KEY`, so it
 * reaches only the main bundle and never the renderer. A build made without one
 * is inert: that is the expected state of a local `pnpm run package`, and it is
 * reported once as a warning rather than failing or retrying.
 *
 * A dev run sends nothing unless `SWITCHDASH_TELEMETRY_DEV=1`, mirroring how the
 * updater stays inert outside packaged builds. With it set, a dev run can be
 * pointed at a local listener with `SWITCHDASH_TELEMETRY_ENDPOINT` — that
 * override is dev-only, so a packaged build cannot be redirected.
 */
export function resolveTelemetryConfig(): TelemetryResolution {
  const build = telemetryBuildChannel();
  if (build === 'dev' && process.env.SWITCHDASH_TELEMETRY_DEV !== '1') {
    return { enabled: false, reason: 'dev_build' };
  }

  const apiKey = (
    viteEnv?.MAIN_VITE_AMPLITUDE_API_KEY ??
    process.env.MAIN_VITE_AMPLITUDE_API_KEY ??
    ''
  ).trim();
  if (!apiKey) return { enabled: false, reason: 'no_api_key' };

  const override = build === 'dev' ? process.env.SWITCHDASH_TELEMETRY_ENDPOINT?.trim() : undefined;
  return { enabled: true, config: { apiKey, endpoint: override || AMPLITUDE_US_ENDPOINT, build } };
}
