import { spawnSync } from 'node:child_process';
import { log } from '@main/lib/logger';

const SECRET_SERVICE = 'org.freedesktop.secrets';
const DBUS_CALL_TIMEOUT_MS = 500;

export type SecretServiceProbe =
  | { kind: 'present' }
  | { kind: 'absent' }
  | { kind: 'failed'; reason: string };

export type DbusCallResult = { ok: true; stdout: string } | { ok: false; reason: string };

/** Calls a method on the session bus daemon itself, the way `dbus-send` prints its reply. */
export type DbusCall = (method: 'NameHasOwner' | 'ListActivatableNames') => DbusCallResult;

export function dbusSend(method: 'NameHasOwner' | 'ListActivatableNames'): DbusCallResult {
  const args = [
    '--session',
    '--print-reply',
    `--reply-timeout=${DBUS_CALL_TIMEOUT_MS}`,
    '--dest=org.freedesktop.DBus',
    '/org/freedesktop/DBus',
    `org.freedesktop.DBus.${method}`,
    ...(method === 'NameHasOwner' ? [`string:${SECRET_SERVICE}`] : []),
  ];
  const result = spawnSync('dbus-send', args, {
    encoding: 'utf8',
    timeout: DBUS_CALL_TIMEOUT_MS * 2,
  });
  if (result.error) return { ok: false, reason: `dbus-send: ${result.error.message}` };
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `dbus-send ${method} exited ${result.status ?? result.signal}: ${result.stderr.trim()}`,
    };
  }
  return { ok: true, stdout: result.stdout };
}

function hasSessionBus(env: NodeJS.ProcessEnv, fileExists: (file: string) => boolean): boolean {
  if (env.DBUS_SESSION_BUS_ADDRESS) return true;
  return Boolean(env.XDG_RUNTIME_DIR) && fileExists(`${env.XDG_RUNTIME_DIR}/bus`);
}

/**
 * Whether a Secret Service (gnome-keyring, KeePassXC, ...) is on the session
 * bus: `org.freedesktop.secrets` has an owner, or D-Bus can start one. With no
 * session bus at all there is none. Synchronous, because it runs before the
 * app is ready, when command-line switches still take effect.
 */
export function probeSecretService(
  env: NodeJS.ProcessEnv,
  fileExists: (file: string) => boolean,
  call: DbusCall
): SecretServiceProbe {
  if (!hasSessionBus(env, fileExists)) return { kind: 'absent' };

  const owner = call('NameHasOwner');
  if (!owner.ok) return { kind: 'failed', reason: owner.reason };
  if (/\bboolean true\b/.test(owner.stdout)) return { kind: 'present' };

  const activatable = call('ListActivatableNames');
  if (!activatable.ok) return { kind: 'failed', reason: activatable.reason };
  return activatable.stdout.includes(`string "${SECRET_SERVICE}"`)
    ? { kind: 'present' }
    : { kind: 'absent' };
}

export type ChromiumKeyring = 'kwallet' | 'gnome-libsecret' | 'basic_text';

const SECRET_SERVICE_DESKTOPS = [
  'Unity',
  'Deepin',
  'GNOME',
  'X-Cinnamon',
  'Pantheon',
  'XFCE',
  'UKUI',
  'COSMIC',
];
const SECRET_SERVICE_SESSIONS = ['deepin', 'gnome', 'mate', 'ukui', 'xubuntu'];

/**
 * The keyring Chromium picks by itself when no `--password-store` is passed:
 * `base::nix::GetDesktopEnvironment` (base/nix/xdg_util.cc) mapped through
 * `SelectBackend` (components/os_crypt/sync/key_storage_util_linux.cc), as in
 * the Chromium Electron 41 ships. Only the outcome matters here, so the KWallet
 * versions are folded together. A desktop it does not recognise (Hyprland,
 * Sway, i3, niri, LXQt) or none at all gets `basic_text`.
 */
export function chromiumDefaultKeyring(env: NodeJS.ProcessEnv): ChromiumKeyring {
  const desktops = (env.XDG_CURRENT_DESKTOP ?? '')
    .split(':')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const desktop of desktops) {
    if (desktop === 'KDE') return 'kwallet';
    if (desktop === 'LXQt') return 'basic_text';
    if (SECRET_SERVICE_DESKTOPS.includes(desktop)) return 'gnome-libsecret';
  }

  const session = env.DESKTOP_SESSION ?? '';
  if (SECRET_SERVICE_SESSIONS.includes(session) || session.includes('xfce')) {
    return 'gnome-libsecret';
  }
  if (session === 'kde4' || session === 'kde-plasma') return 'kwallet';
  if (session === 'kde') return env.KDE_SESSION_VERSION === undefined ? 'basic_text' : 'kwallet';

  if (env.GNOME_DESKTOP_SESSION_ID !== undefined) return 'gnome-libsecret';
  if (env.KDE_FULL_SESSION !== undefined) {
    return env.KDE_SESSION_VERSION === undefined ? 'basic_text' : 'kwallet';
  }
  return 'basic_text';
}

function describeDesktop(env: NodeJS.ProcessEnv): string {
  return env.XDG_CURRENT_DESKTOP
    ? `desktop "${env.XDG_CURRENT_DESKTOP}"`
    : 'no desktop environment (XDG_CURRENT_DESKTOP unset)';
}

/**
 * The `--password-store` Chromium should use on Linux when the launch did not
 * choose one, or null to leave its own choice.
 *
 * Chromium picks a keyring from the desktop environment, and for one it does
 * not recognise (a window manager such as Hyprland or Sway, or none at all, as
 * under WSL2) it falls back to `basic_text`, which the secrets store refuses.
 * A running Secret Service is still usable there when asked for, so it is
 * asked for in that case only, and only when one is on the session bus. A
 * desktop Chromium already handles, KDE with KWallet included, is left alone.
 */
export function linuxPasswordStoreFallback(
  env: NodeJS.ProcessEnv,
  passwordStoreChosen: boolean,
  probe: () => SecretServiceProbe
): string | null {
  if (passwordStoreChosen) return null;
  if (chromiumDefaultKeyring(env) !== 'basic_text') return null;

  const desktop = describeDesktop(env);
  const secretService = probe();
  if (secretService.kind === 'failed') {
    log.warn(
      `Chromium has no keyring for ${desktop}, and checking the session bus for a Secret ` +
        `Service failed (${secretService.reason}). Secrets cannot be saved unless Switch ` +
        'Console is started with --password-store=gnome-libsecret.'
    );
    return null;
  }
  if (secretService.kind === 'absent') {
    log.warn(
      `Chromium has no keyring for ${desktop} and no Secret Service is on the session bus. ` +
        'Secrets cannot be saved until one, such as gnome-keyring, is running.'
    );
    return null;
  }
  log.info(`Using the Secret Service for secret storage: Chromium has no keyring for ${desktop}.`);
  return 'gnome-libsecret';
}
