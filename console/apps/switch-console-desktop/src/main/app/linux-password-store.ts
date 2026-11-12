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

/**
 * The `--password-store` Chromium should use on Linux when the launch did not
 * choose one, or null to leave its own choice.
 *
 * Chromium picks a keyring from the desktop environment, and with none
 * (`XDG_CURRENT_DESKTOP` unset: WSL2, a headless box, a bare window manager)
 * it falls back to `basic_text`, which the secrets store refuses. A running
 * Secret Service is still usable there when asked for, so it is asked for
 * only when one is on the session bus.
 */
export function linuxPasswordStoreFallback(
  env: NodeJS.ProcessEnv,
  passwordStoreChosen: boolean,
  probe: () => SecretServiceProbe
): string | null {
  if (passwordStoreChosen) return null;
  if (env.XDG_CURRENT_DESKTOP) return null;

  const secretService = probe();
  if (secretService.kind === 'failed') {
    log.warn(
      `Could not check the session bus for a Secret Service (${secretService.reason}); ` +
        'leaving the keyring choice to Chromium.'
    );
    return null;
  }
  return secretService.kind === 'present' ? 'gnome-libsecret' : null;
}
