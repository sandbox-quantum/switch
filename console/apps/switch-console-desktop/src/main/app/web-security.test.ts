import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, session: {} }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./protocol', () => ({ isAppRendererUrl: vi.fn() }));
vi.mock('./window', () => ({ getMainWindow: vi.fn() }));

const { isPermissionGranted } = await import('./web-security');

describe('isPermissionGranted', () => {
  it.each([
    'media',
    'geolocation',
    'notifications',
    'clipboard-read',
    'deprecated-sync-clipboard-read',
    'display-capture',
    'midi',
    'midiSysex',
    'hid',
    'serial',
    'usb',
    'idle-detection',
    'pointerLock',
    'keyboardLock',
    'window-management',
    'fileSystem',
    'unknown',
  ])('refuses %s, even to the app window', (permission) => {
    expect(isPermissionGranted({ permission, fromAppWindow: true, externalUrl: undefined })).toBe(
      false
    );
  });

  it.each(['clipboard-sanitized-write', 'fullscreen', 'storage-access'])(
    'grants %s, which copy buttons, media and embedded sign-ins use',
    (permission) => {
      expect(
        isPermissionGranted({ permission, fromAppWindow: false, externalUrl: undefined })
      ).toBe(true);
    }
  );

  it('lets the app window hand a messaging-app link to the OS', () => {
    expect(
      isPermissionGranted({
        permission: 'openExternal',
        fromAppWindow: true,
        externalUrl: 'slack://channel?team=T1&id=C1',
      })
    ).toBe(true);
  });

  it('refuses the app window a scheme Console does not open', () => {
    expect(
      isPermissionGranted({
        permission: 'openExternal',
        fromAppWindow: true,
        externalUrl: 'search-ms:query=x',
      })
    ).toBe(false);
  });

  it('refuses any other page an OS launch, whatever the scheme', () => {
    for (const externalUrl of ['slack://channel?id=C1', 'some-app://run', undefined]) {
      expect(
        isPermissionGranted({ permission: 'openExternal', fromAppWindow: false, externalUrl })
      ).toBe(false);
    }
  });
});
