import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as AppIdentity from '@shared/app-identity';

const checkout = vi.hoisted(() => ({ root: null as string | null }));
vi.mock('@shared/app-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof AppIdentity>()),
  COMPATIBLE_SWITCH_VERSION: '0.31.0-rc.7',
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./checkout-build', () => ({ findCoreCheckout: () => checkout.root }));

const { parseServerVersionChoice, serverVersionSetting } = await import('./server-version');

/** A fresh copy of the module, so its once-per-run resolution runs again. */
async function freshModule() {
  vi.resetModules();
  return import('./server-version');
}

afterEach(() => {
  vi.unstubAllEnvs();
  checkout.root = null;
});

describe('parseServerVersionChoice', () => {
  const noCheckout = () => null;

  it.each([undefined, ''])('keeps the pin when the variable is %j', (raw) => {
    expect(parseServerVersionChoice(raw, '0.31.0-rc.7', noCheckout)).toEqual({
      kind: 'pin',
      version: '0.31.0-rc.7',
    });
  });

  it.each(['0.30.0', '0.31.0-rc.7', '1.2.3-beta.1.x'])('runs the release %j', (raw) => {
    expect(parseServerVersionChoice(raw, '0.31.0-rc.7', noCheckout)).toEqual({
      kind: 'release',
      version: raw,
    });
  });

  it.each(['v0.30.0', '0.30', '0.30.0+build.1', ' 0.30.0', 'latest', 'Checkout', '0.30.0-'])(
    'refuses %j, naming the variable',
    (raw) => {
      expect(() => parseServerVersionChoice(raw, '0.31.0-rc.7', noCheckout)).toThrow(
        /^SWITCH_CONSOLE_SERVER_VERSION must be a switch-core release version/
      );
    }
  );

  it('runs the checkout it finds, keeping the pin for what cannot build from it', () => {
    expect(parseServerVersionChoice('checkout', '0.31.0-rc.7', () => '/src/switch')).toEqual({
      kind: 'checkout',
      version: '0.31.0-rc.7',
      root: '/src/switch',
    });
  });

  it('refuses checkout when there is no checkout to run', () => {
    expect(() => parseServerVersionChoice('checkout', '0.31.0-rc.7', noCheckout)).toThrow(
      /^SWITCH_CONSOLE_SERVER_VERSION=checkout .* no checkout was found/
    );
  });
});

describe('serverVersionSetting', () => {
  it('names the setting behind an override, and nothing for the pin', () => {
    expect(serverVersionSetting({ kind: 'pin', version: '0.31.0-rc.7' })).toBeNull();
    expect(serverVersionSetting({ kind: 'release', version: '0.30.0' })).toBe(
      'SWITCH_CONSOLE_SERVER_VERSION=0.30.0'
    );
    expect(serverVersionSetting({ kind: 'checkout', version: '0.31.0-rc.7', root: '/s' })).toBe(
      'SWITCH_CONSOLE_SERVER_VERSION=checkout'
    );
  });
});

describe('serverVersionChoice', () => {
  it('runs the pin when the variable is unset', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('SWITCH_CONSOLE_SERVER_VERSION', '');
    const { managedSwitchVersion, serverVersionChoice } = await freshModule();
    expect(serverVersionChoice()).toEqual({ kind: 'pin', version: '0.31.0-rc.7' });
    expect(managedSwitchVersion()).toBe('0.31.0-rc.7');
  });

  it('runs the release a dev build is told to', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('SWITCH_CONSOLE_SERVER_VERSION', '0.30.0');
    const { managedSwitchVersion } = await freshModule();
    expect(managedSwitchVersion()).toBe('0.30.0');
  });

  it('runs this checkout in a dev build launched from one', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('SWITCH_CONSOLE_SERVER_VERSION', 'checkout');
    checkout.root = '/src/switch';
    const { managedSwitchVersion, serverVersionChoice } = await freshModule();
    expect(serverVersionChoice()).toEqual({
      kind: 'checkout',
      version: '0.31.0-rc.7',
      root: '/src/switch',
    });
    expect(managedSwitchVersion()).toBe('0.31.0-rc.7');
  });

  it('fails the launch on a value it cannot honour', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('SWITCH_CONSOLE_SERVER_VERSION', 'checkout');
    const { serverVersionChoice } = await freshModule();
    expect(() => serverVersionChoice()).toThrow(/SWITCH_CONSOLE_SERVER_VERSION=checkout/);
  });

  it('is ignored by a stable or canary build, however it is set', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('SWITCH_CONSOLE_SERVER_VERSION', 'not a version');
    const { serverVersionChoice } = await freshModule();
    expect(serverVersionChoice()).toEqual({ kind: 'pin', version: '0.31.0-rc.7' });
  });

  it('reads the variable once per run', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('SWITCH_CONSOLE_SERVER_VERSION', '0.30.0');
    const { managedSwitchVersion } = await freshModule();
    expect(managedSwitchVersion()).toBe('0.30.0');
    vi.stubEnv('SWITCH_CONSOLE_SERVER_VERSION', '0.29.0');
    expect(managedSwitchVersion()).toBe('0.30.0');
  });
});
