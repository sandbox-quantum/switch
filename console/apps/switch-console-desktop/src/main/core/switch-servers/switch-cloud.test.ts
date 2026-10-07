import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isHiddenSwitchCloudServer,
  requireSwitchCloudEnabled,
  requireSwitchCloudEndpoint,
  switchCloudEnabled,
  switchCloudEndpoint,
} from './switch-cloud';

afterEach(() => {
  vi.unstubAllEnvs();
});

function enableWith(run: string | undefined, build: string | undefined) {
  vi.stubEnv('SWITCH_CLOUD_ENABLED', run);
  vi.stubEnv('MAIN_VITE_SWITCH_CLOUD_ENABLED', build);
}

function runWith(value: string | undefined) {
  enableWith('true', undefined);
  vi.stubEnv('SWITCH_CLOUD_URL', value);
  vi.stubEnv('MAIN_VITE_SWITCH_CLOUD_URL', undefined);
}

describe('switchCloudEnabled', () => {
  it('is off when nothing turns it on', () => {
    enableWith(undefined, undefined);
    expect(switchCloudEnabled()).toBe(false);
  });

  it('treats a blank value as unset', () => {
    enableWith('  ', undefined);
    expect(switchCloudEnabled()).toBe(false);
  });

  it('is on only for exactly true', () => {
    enableWith('true', undefined);
    expect(switchCloudEnabled()).toBe(true);
    enableWith('false', undefined);
    expect(switchCloudEnabled()).toBe(false);
  });

  it('falls back to the build-time value', () => {
    enableWith(undefined, 'true');
    expect(switchCloudEnabled()).toBe(true);
  });

  it('prefers the run-time value over the build-time one', () => {
    enableWith('false', 'true');
    expect(switchCloudEnabled()).toBe(false);
    enableWith('true', 'false');
    expect(switchCloudEnabled()).toBe(true);
  });

  it('raises on a value that is not true or false', () => {
    enableWith('TRUE', undefined);
    expect(() => switchCloudEnabled()).toThrow('SWITCH_CLOUD_ENABLED must be "true" or "false"');
    enableWith(undefined, '1');
    expect(() => switchCloudEnabled()).toThrow(
      'MAIN_VITE_SWITCH_CLOUD_ENABLED must be "true" or "false"'
    );
  });

  it('refuses Cloud work when off', () => {
    enableWith('false', undefined);
    expect(() => requireSwitchCloudEnabled()).toThrow('Switch Cloud is turned off');
    enableWith('true', undefined);
    expect(() => requireSwitchCloudEnabled()).not.toThrow();
  });
});

describe('isHiddenSwitchCloudServer', () => {
  const cloud = { gatewayUrl: 'https://cloud.example.com' };
  const other = { gatewayUrl: 'https://switch.example.org' };

  it('hides the Cloud server when Switch Cloud is off', () => {
    runWith('https://cloud.example.com');
    enableWith(undefined, undefined);
    expect(isHiddenSwitchCloudServer(cloud)).toBe(true);
    expect(isHiddenSwitchCloudServer(other)).toBe(false);
  });

  it('hides nothing when Switch Cloud is on', () => {
    runWith('https://cloud.example.com');
    expect(isHiddenSwitchCloudServer(cloud)).toBe(false);
  });

  it('hides nothing when no Cloud URL is named', () => {
    runWith(undefined);
    enableWith('false', undefined);
    expect(isHiddenSwitchCloudServer(cloud)).toBe(false);
  });
});

describe('switchCloudEndpoint', () => {
  it('is null when nothing names a Cloud', () => {
    runWith(undefined);
    expect(switchCloudEndpoint()).toBeNull();
  });

  it('treats a blank value as unset', () => {
    runWith('   ');
    expect(switchCloudEndpoint()).toBeNull();
  });

  it('returns the origin of an https URL', () => {
    runWith(' https://cloud.example.com/ ');
    expect(switchCloudEndpoint()).toEqual({ url: 'https://cloud.example.com' });
  });

  it('falls back to the build-time value', () => {
    enableWith('true', undefined);
    vi.stubEnv('SWITCH_CLOUD_URL', undefined);
    vi.stubEnv('MAIN_VITE_SWITCH_CLOUD_URL', 'https://built.example.com');
    expect(switchCloudEndpoint()).toEqual({ url: 'https://built.example.com' });
  });

  it('prefers the run-time value over the build-time one', () => {
    enableWith('true', undefined);
    vi.stubEnv('SWITCH_CLOUD_URL', 'https://run.example.com');
    vi.stubEnv('MAIN_VITE_SWITCH_CLOUD_URL', 'https://built.example.com');
    expect(switchCloudEndpoint()).toEqual({ url: 'https://run.example.com' });
  });

  it('raises on a value that is not a URL', () => {
    runWith('not a url');
    expect(() => switchCloudEndpoint()).toThrow('SWITCH_CLOUD_URL is not a URL');
  });

  it('raises on plain http', () => {
    runWith('http://cloud.example.com');
    expect(() => switchCloudEndpoint()).toThrow('must be an https URL');
  });

  it('accepts plain http to this machine, for a local stand-in', () => {
    runWith('http://localhost:8000');
    expect(switchCloudEndpoint()).toEqual({ url: 'http://localhost:8000' });
    runWith('http://127.0.0.1:8000');
    expect(switchCloudEndpoint()).toEqual({ url: 'http://127.0.0.1:8000' });
    runWith('http://[::1]:8000');
    expect(switchCloudEndpoint()).toEqual({ url: 'http://[::1]:8000' });
  });

  it('does not take a host that only starts like localhost', () => {
    runWith('http://localhost.example.com');
    expect(() => switchCloudEndpoint()).toThrow('must be an https URL');
  });

  it('raises on a URL with a path', () => {
    runWith('https://cloud.example.com/gateway');
    expect(() => switchCloudEndpoint()).toThrow('must be an origin with no path');
  });
});

describe('switchCloudEndpoint when Switch Cloud is off', () => {
  it('is null even when a Cloud URL is named', () => {
    runWith('https://cloud.example.com');
    enableWith(undefined, undefined);
    expect(switchCloudEndpoint()).toBeNull();
  });
});

describe('requireSwitchCloudEndpoint', () => {
  it('raises when Switch Cloud is off', () => {
    runWith('https://cloud.example.com');
    enableWith('false', undefined);
    expect(() => requireSwitchCloudEndpoint()).toThrow('Switch Cloud is turned off');
  });

  it('raises when nothing names a Cloud', () => {
    runWith(undefined);
    expect(() => requireSwitchCloudEndpoint()).toThrow('Switch Cloud is not configured');
  });
});
