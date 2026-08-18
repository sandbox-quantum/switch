import { appSettingsService } from '@main/core/settings/settings-service';
import { log } from '@main/lib/logger';
import { createDirTrustService } from './dir-trust';

export { createDirTrustService, DirTrustService } from './dir-trust';

/** The trust writers for this machine, for sessions the desktop starts here. */
export const dirTrustService = createDirTrustService({
  getSessionSettings: () => appSettingsService.get('sessions'),
  log,
});
