import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbusCall } from './linux-password-store';

const warn = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());
vi.mock('@main/lib/logger', () => ({ log: { warn, info } }));

const { chromiumDefaultKeyring, linuxPasswordStoreFallback, probeSecretService } =
  await import('./linux-password-store');

const present = () => ({ kind: 'present' as const });
const absent = () => ({ kind: 'absent' as const });

beforeEach(() => {
  warn.mockReset();
  info.mockReset();
});

describe('chromiumDefaultKeyring', () => {
  it.each([
    [{ XDG_CURRENT_DESKTOP: 'GNOME' }, 'gnome-libsecret'],
    [{ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, 'gnome-libsecret'],
    [{ XDG_CURRENT_DESKTOP: 'X-Cinnamon' }, 'gnome-libsecret'],
    [{ XDG_CURRENT_DESKTOP: 'XFCE' }, 'gnome-libsecret'],
    [{ XDG_CURRENT_DESKTOP: 'COSMIC' }, 'gnome-libsecret'],
    [{ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' }, 'kwallet'],
    [{ XDG_CURRENT_DESKTOP: 'KDE' }, 'kwallet'],
    [{ XDG_CURRENT_DESKTOP: 'Hyprland' }, 'basic_text'],
    [{ XDG_CURRENT_DESKTOP: 'sway' }, 'basic_text'],
    [{ XDG_CURRENT_DESKTOP: 'i3' }, 'basic_text'],
    [{ XDG_CURRENT_DESKTOP: 'LXQt' }, 'basic_text'],
    [{ XDG_CURRENT_DESKTOP: 'MATE', DESKTOP_SESSION: 'mate' }, 'gnome-libsecret'],
    [{ XDG_CURRENT_DESKTOP: 'Hyprland', DESKTOP_SESSION: 'hyprland' }, 'basic_text'],
    [{ DESKTOP_SESSION: 'kde-plasma' }, 'kwallet'],
    [{ DESKTOP_SESSION: 'xfce4' }, 'gnome-libsecret'],
    [{ GNOME_DESKTOP_SESSION_ID: 'this-is-deprecated' }, 'gnome-libsecret'],
    [{ KDE_FULL_SESSION: 'true', KDE_SESSION_VERSION: '5' }, 'kwallet'],
    [{}, 'basic_text'],
  ])('maps %o to %s', (env, keyring) => {
    expect(chromiumDefaultKeyring(env)).toBe(keyring);
  });
});

describe('linuxPasswordStoreFallback', () => {
  it('asks for the Secret Service when there is no desktop environment and one is running', () => {
    expect(linuxPasswordStoreFallback({}, false, present)).toBe('gnome-libsecret');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('XDG_CURRENT_DESKTOP unset'));
  });

  it('asks for the Secret Service under a window manager Chromium does not recognise', () => {
    const env = { XDG_CURRENT_DESKTOP: 'Hyprland' };
    expect(linuxPasswordStoreFallback(env, false, present)).toBe('gnome-libsecret');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"Hyprland"'));
  });

  it('leaves the choice to Chromium, with a warning, when no Secret Service is on the bus', () => {
    expect(linuxPasswordStoreFallback({ XDG_CURRENT_DESKTOP: 'sway' }, false, absent)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no Secret Service'));
  });

  it('leaves the choice to Chromium, naming the workaround, when the probe fails', () => {
    const failed = () => ({ kind: 'failed' as const, reason: 'dbus-send: spawn ENOENT' });
    expect(linuxPasswordStoreFallback({}, false, failed)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dbus-send: spawn ENOENT'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('--password-store=gnome-libsecret'));
  });

  it.each(['KDE', 'GNOME', 'ubuntu:GNOME'])(
    'leaves the choice to Chromium under %s, without probing',
    (desktop) => {
      const probe = vi.fn(present);
      expect(linuxPasswordStoreFallback({ XDG_CURRENT_DESKTOP: desktop }, false, probe)).toBeNull();
      expect(probe).not.toHaveBeenCalled();
    }
  );

  it('keeps a --password-store the launch passed, without probing', () => {
    const probe = vi.fn(present);
    expect(linuxPasswordStoreFallback({}, true, probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('probeSecretService', () => {
  const bus = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
  const noFiles = () => false;
  const reply = (stdout: string) => ({ ok: true as const, stdout });
  const NOT_OWNED = 'method return time=1 sender=org.freedesktop.DBus\n   boolean false\n';
  const OWNED = 'method return time=1 sender=org.freedesktop.DBus\n   boolean true\n';
  const listing = (...names: string[]) =>
    `method return time=1\n   array [\n${names.map((n) => `      string "${n}"\n`).join('')}   ]\n`;

  it('finds a Secret Service that owns its name', () => {
    const call = vi.fn<DbusCall>(() => reply(OWNED));
    expect(probeSecretService(bus, noFiles, call)).toEqual({ kind: 'present' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('finds a Secret Service D-Bus can start', () => {
    const call: DbusCall = (method) =>
      reply(
        method === 'NameHasOwner'
          ? NOT_OWNED
          : listing('org.freedesktop.DBus', 'org.freedesktop.secrets')
      );
    expect(probeSecretService(bus, noFiles, call)).toEqual({ kind: 'present' });
  });

  it('reports none when the name is neither owned nor activatable', () => {
    const call: DbusCall = (method) =>
      reply(
        method === 'NameHasOwner' ? NOT_OWNED : listing('org.freedesktop.DBus', 'org.kde.kwalletd5')
      );
    expect(probeSecretService(bus, noFiles, call)).toEqual({ kind: 'absent' });
  });

  it('reports none without asking when there is no session bus', () => {
    const call = vi.fn<DbusCall>();
    expect(probeSecretService({}, noFiles, call)).toEqual({ kind: 'absent' });
    expect(call).not.toHaveBeenCalled();
  });

  it('finds the session bus at its default path under XDG_RUNTIME_DIR', () => {
    const exists = (file: string) => file === '/run/user/1000/bus';
    const call = vi.fn<DbusCall>(() => reply(OWNED));
    expect(probeSecretService({ XDG_RUNTIME_DIR: '/run/user/1000' }, exists, call)).toEqual({
      kind: 'present',
    });
  });

  it('reports a failed call as a failure, not as no Secret Service', () => {
    const call: DbusCall = () => ({ ok: false, reason: 'dbus-send: spawn dbus-send ENOENT' });
    expect(probeSecretService(bus, noFiles, call)).toEqual({
      kind: 'failed',
      reason: 'dbus-send: spawn dbus-send ENOENT',
    });
  });
});
