import { describe, expect, it } from 'vitest';
import {
  resolveTelemetryEnvironment,
  TELEMETRY_RELAY_ENDPOINT,
  type TelemetryBuildChannel,
  type TelemetryEnvironment,
} from './config';

function resolve(build: TelemetryBuildChannel, env: TelemetryEnvironment['env'] = {}) {
  return resolveTelemetryEnvironment({ build, env });
}

describe('a dev run', () => {
  it('is off until a developer opts in', () => {
    expect(resolve('dev')).toEqual({ enabled: false, reason: 'dev_build' });
  });

  it('reports to the relay once opted in', () => {
    expect(resolve('dev', { SWITCHDASH_TELEMETRY_DEV: '1' })).toEqual({
      enabled: true,
      config: { endpoint: TELEMETRY_RELAY_ENDPOINT, build: 'dev' },
    });
  });

  it('can be pointed at a local listener, so what it sends can be watched', () => {
    const resolution = resolve('dev', {
      SWITCHDASH_TELEMETRY_DEV: '1',
      SWITCHDASH_TELEMETRY_ENDPOINT: 'http://127.0.0.1:9009',
    });

    expect(resolution.enabled && resolution.config.endpoint).toBe('http://127.0.0.1:9009');
  });

  it('ignores a blank override rather than posting nowhere', () => {
    const resolution = resolve('dev', {
      SWITCHDASH_TELEMETRY_DEV: '1',
      SWITCHDASH_TELEMETRY_ENDPOINT: '   ',
    });

    expect(resolution.enabled && resolution.config.endpoint).toBe(TELEMETRY_RELAY_ENDPOINT);
  });
});

describe.each(['stable', 'canary'] as const)('a %s build', (build) => {
  it('reports to the relay, with nothing to configure', () => {
    // The relay holds the vendor keys, so unlike the direct-to-Amplitude shape
    // this replaced, there is no build that is inert for want of a key.
    expect(resolve(build)).toEqual({
      enabled: true,
      config: { endpoint: TELEMETRY_RELAY_ENDPOINT, build },
    });
  });

  it('cannot be redirected away from the relay', () => {
    // Otherwise anything able to set a variable before launch — a shell
    // profile, a launch script, an MDM policy — could collect a consenting
    // user's events somewhere of its own.
    const resolution = resolve(build, {
      SWITCHDASH_TELEMETRY_ENDPOINT: 'http://somewhere.example',
    });

    expect(resolution.enabled && resolution.config.endpoint).toBe(TELEMETRY_RELAY_ENDPOINT);
  });

  it('ignores the dev opt-in switch', () => {
    const resolution = resolve(build, { SWITCHDASH_TELEMETRY_DEV: '1' });

    expect(resolution.enabled && resolution.config.build).toBe(build);
  });
});
