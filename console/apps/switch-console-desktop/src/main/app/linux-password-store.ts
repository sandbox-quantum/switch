/**
 * The `--password-store` Chromium should use on Linux when the launch did not
 * choose one, or null to leave its own choice.
 *
 * Chromium picks a keyring from the desktop environment, and with none
 * (`XDG_CURRENT_DESKTOP` unset: WSL2, a headless box, a bare window manager)
 * it falls back to `basic_text`, which the secrets store refuses. A running
 * Secret Service such as gnome-keyring is still usable there when asked for.
 */
export function linuxPasswordStoreFallback(
  env: NodeJS.ProcessEnv,
  passwordStoreChosen: boolean
): string | null {
  if (passwordStoreChosen) return null;
  if (env.XDG_CURRENT_DESKTOP) return null;
  return 'gnome-libsecret';
}
