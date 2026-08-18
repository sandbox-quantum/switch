import type { Hotkey } from '@tanstack/react-hotkeys';
import { APP_SHORTCUTS, resolveDefaultHotkey, type ShortcutSettingsKey } from '@shared/shortcuts';

export type { AppShortcutDef, ShortcutSettingsKey } from '@shared/shortcuts';
export { APP_SHORTCUTS, resolveDefaultHotkey } from '@shared/shortcuts';

/**
 * Returns the hotkey assigned to an action, or `null` when it has no
 * `defaultHotkey` on the current platform (not bound).
 */
export function getEffectiveHotkey(key: ShortcutSettingsKey): Hotkey | null {
  const resolved = resolveDefaultHotkey(APP_SHORTCUTS[key]);
  return resolved != null ? (resolved as Hotkey) : null;
}

/**
 * Always returns a valid hotkey string for hook registration.
 * Pair this with `getEffectiveHotkey(...) !== null` in `enabled`.
 */
export function getHotkeyRegistration(key: ShortcutSettingsKey): Hotkey {
  return (getEffectiveHotkey(key) ?? '') as Hotkey;
}
