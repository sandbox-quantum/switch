import { describe, expect, it } from 'vitest';
import {
  AMPLITUDE_US_ENDPOINT,
  resolveTelemetryEnvironment,
  type TelemetryBuildChannel,
  type TelemetryEnvironment,
} from './config';

function resolve(
  build: TelemetryBuildChannel,
  env: TelemetryEnvironment['env'] = {},
  bakedKey?: string
) {
  return resolveTelemetryEnvironment({ build, bakedKey, env });
}

describe('a dev run', () => {
  it('is off until a developer opts in', () => {
    expect(resolve('dev', { MAIN_VITE_AMPLITUDE_API_KEY: 'key' })).toEqual({
      enabled: false,
      reason: 'dev_build',
    });
  });

  it('is still off, once opted in, without a key', () => {
    expect(resolve('dev', { SWITCHDASH_TELEMETRY_DEV: '1' })).toEqual({
      enabled: false,
      reason: 'no_api_key',
    });
  });

  it('sends to Amplitude when opted in with a key from the environment', () => {
    expect(
      resolve('dev', { SWITCHDASH_TELEMETRY_DEV: '1', MAIN_VITE_AMPLITUDE_API_KEY: 'key' })
    ).toEqual({
      enabled: true,
      config: { apiKey: 'key', endpoint: AMPLITUDE_US_ENDPOINT, build: 'dev' },
    });
  });

  it('can be pointed at a local listener, so what it sends can be watched', () => {
    const resolution = resolve('dev', {
      SWITCHDASH_TELEMETRY_DEV: '1',
      MAIN_VITE_AMPLITUDE_API_KEY: 'key',
      SWITCHDASH_TELEMETRY_ENDPOINT: 'http://127.0.0.1:9009',
    });

    expect(resolution.enabled && resolution.config.endpoint).toBe('http://127.0.0.1:9009');
  });

  it('treats a blank key as no key', () => {
    expect(
      resolve('dev', { SWITCHDASH_TELEMETRY_DEV: '1', MAIN_VITE_AMPLITUDE_API_KEY: '   ' })
    ).toEqual({ enabled: false, reason: 'no_api_key' });
  });
});

describe.each(['stable', 'canary'] as const)('a %s build', (build) => {
  it('sends with the key it was built with', () => {
    expect(resolve(build, {}, 'baked-key')).toEqual({
      enabled: true,
      config: { apiKey: 'baked-key', endpoint: AMPLITUDE_US_ENDPOINT, build },
    });
  });

  it('is inert when it was built without one', () => {
    expect(resolve(build)).toEqual({ enabled: false, reason: 'no_api_key' });
  });

  it('ignores a key offered by the environment', () => {
    // Otherwise anything able to set a variable before launch — a shell
    // profile, a launch script, an MDM policy — could point a consenting
    // user's events at its own Amplitude project.
    expect(resolve(build, { MAIN_VITE_AMPLITUDE_API_KEY: 'someone-elses-key' })).toEqual({
      enabled: false,
      reason: 'no_api_key',
    });
  });

  it('cannot be redirected away from Amplitude', () => {
    const resolution = resolve(
      build,
      { SWITCHDASH_TELEMETRY_ENDPOINT: 'http://somewhere.example' },
      'baked-key'
    );

    expect(resolution.enabled && resolution.config.endpoint).toBe(AMPLITUDE_US_ENDPOINT);
  });

  it('ignores the dev opt-in switch', () => {
    expect(resolve(build, { SWITCHDASH_TELEMETRY_DEV: '1' })).toEqual({
      enabled: false,
      reason: 'no_api_key',
    });
  });
});
