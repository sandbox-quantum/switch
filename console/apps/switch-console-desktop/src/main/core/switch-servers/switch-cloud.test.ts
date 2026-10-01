import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireSwitchCloudEndpoint, switchCloudEndpoint } from './switch-cloud';

afterEach(() => {
  vi.unstubAllEnvs();
});

function runWith(value: string | undefined) {
  vi.stubEnv('SWITCH_CLOUD_URL', value);
  vi.stubEnv('MAIN_VITE_SWITCH_CLOUD_URL', undefined);
}

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
    vi.stubEnv('SWITCH_CLOUD_URL', undefined);
    vi.stubEnv('MAIN_VITE_SWITCH_CLOUD_URL', 'https://built.example.com');
    expect(switchCloudEndpoint()).toEqual({ url: 'https://built.example.com' });
  });

  it('prefers the run-time value over the build-time one', () => {
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

describe('requireSwitchCloudEndpoint', () => {
  it('raises when nothing names a Cloud', () => {
    runWith(undefined);
    expect(() => requireSwitchCloudEndpoint()).toThrow('Switch Cloud is not configured');
  });
});
