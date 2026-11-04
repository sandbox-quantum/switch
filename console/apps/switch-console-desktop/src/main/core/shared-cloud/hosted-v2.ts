import { featureFlagsService } from '@main/core/feature-flags/feature-flags';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { sharedCloudMock } from './mock-mode';

/**
 * Whether the server runs hosted agents v2 (`hosted_v2`), Core's single answer.
 * Off, missing (an older Core) or unread all mean false, so every v2-only
 * thing the main process does is skipped and Console behaves as upstream.
 * The dev-only shared-cloud mock counts as on (never in a packaged build).
 */
export async function hostedV2On(server: SwitchServer): Promise<boolean> {
  if (sharedCloudMock()) return true;
  return (await featureFlagsService.current(server)).flags.hosted_v2 === true;
}
