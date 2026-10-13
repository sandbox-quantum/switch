import type { TelemetryBridgePlatform } from './events';

/**
 * The shape switch-core holds every platform key to
 * (`messaging_platforms.PLATFORM_KEY_PATTERN`): lowercase, short, no
 * punctuation. A value of this shape cannot carry an identifier or free text.
 */
const PLATFORM_KEY = /^[a-z][a-z0-9_]{1,31}$/;

/**
 * The platforms this build shipped knowing, reportable before any server has
 * been asked which platforms it has.
 */
const BUNDLED_PLATFORMS = ['slack', 'mattermost', 'discord', 'teams', 'telegram'];

/**
 * Every platform key a server listed as a registered bridge type. Those are its
 * adapters, which are code rather than anything a user typed — so once a server
 * has named a platform this way, it is reportable by name.
 */
const knownPlatforms = new Set<string>(BUNDLED_PLATFORMS);

/** Note the platforms a server registered, from its bridge types list. */
export function rememberBridgePlatforms(keys: readonly string[]): void {
  for (const key of keys) {
    if (PLATFORM_KEY.test(key)) knownPlatforms.add(key);
  }
}

/**
 * Narrow a bridge type to something reportable.
 *
 * A bridge's type is free text as far as this app can verify, so it is reported
 * by name only when a server listed it as a registered platform; anything else
 * is `other`. `other` means the server named a platform we cannot vouch for —
 * worth knowing, and distinct from `unknown`, which means we could not find out
 * at all. Collapsing the two would make a new platform look like a lookup
 * failure.
 */
export function bridgePlatformOfType(type: string | null | undefined): TelemetryBridgePlatform {
  if (type === null || type === undefined || type === '') return 'unknown';
  const normalised = type.trim().toLowerCase();
  return knownPlatforms.has(normalised) ? (normalised as TelemetryBridgePlatform) : 'other';
}
