import type { TelemetryBridgePlatform } from './events';

/**
 * The messaging platforms this app knows the names of.
 *
 * The server decides what bridge types exist and names them as free text, so
 * there is no union to import — the list is fetched at runtime and could contain
 * anything. This is the same treatment provider ids get: an unrecognised value
 * is reported as unrecognised rather than passed through, because a platform key
 * we have never heard of is still a string arriving from outside this app.
 */
const KNOWN_PLATFORMS = new Set(['slack', 'mattermost', 'discord', 'teams', 'telegram']);

/**
 * Narrow a bridge type to something reportable.
 *
 * `other` means the server named a platform we do not have a value for — worth
 * knowing, and distinct from `unknown`, which means we could not find out at
 * all. Collapsing the two would make a new platform look like a lookup failure.
 */
export function bridgePlatformOfType(type: string | null | undefined): TelemetryBridgePlatform {
  if (type === null || type === undefined || type === '') return 'unknown';
  const normalised = type.trim().toLowerCase();
  return KNOWN_PLATFORMS.has(normalised) ? (normalised as TelemetryBridgePlatform) : 'other';
}
