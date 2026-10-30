import { log } from '@main/lib/logger';
import { SWITCH_CONSOLE_RELEASES_URL } from '@shared/urls';
import { findLatestCanaryTag } from './canary-feed';

/**
 * The page to download this channel's newest release from by hand.
 *
 * Read from GitHub, never built from a version number. A version can name a
 * release that is not there: the dev harness makes its versions up, and the
 * release workflow deletes all but the newest canaries.
 *
 * Stable needs no lookup. `/releases/latest` redirects to the release GitHub
 * marks Latest, and the release workflow gives that mark only to stable Switch
 * Console releases. Canaries are prereleases, so the newest one is looked up.
 */
export async function manualDownloadUrl(isCanary: boolean): Promise<string> {
  if (!isCanary) return `${SWITCH_CONSOLE_RELEASES_URL}/latest`;

  try {
    return `${SWITCH_CONSOLE_RELEASES_URL}/tag/${await findLatestCanaryTag()}`;
  } catch (error) {
    // The list of releases still has the canary, among other components' builds.
    log.warn('Could not find the newest canary; opening the releases list instead', {
      event: 'update.manual_download',
      stage: 'resolve',
      errorCode: 'canary_lookup_failed',
      error: String(error),
    });
    return SWITCH_CONSOLE_RELEASES_URL;
  }
}
