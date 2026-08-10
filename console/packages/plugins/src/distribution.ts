/**
 * Single source of truth for the Switch plugin-marketplace source — the value
 * passed to `<agent> plugin marketplace add` (a GitHub `owner/repo` or a path)
 * when installing the Switch connector plugin.
 *
 * CHOO-1260 config-flip point: the public-repo move repoints this. See
 * RELEASING.md. Keep in sync with the Switch Console auto-update target
 * (RELEASE_REPO_* in apps/switch-console-desktop/src/shared/app-identity.ts).
 */
export const SWITCH_MARKETPLACE_SOURCE = 'sandbox-quantum/switch';
