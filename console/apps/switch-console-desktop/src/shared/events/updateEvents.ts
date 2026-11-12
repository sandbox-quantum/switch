import type { UpdateInfo } from 'electron-updater';
import { defineEvent } from '@shared/lib/ipc/events';

export const updateCheckingEvent = defineEvent<void>('update:checking');

export const updateAvailableEvent = defineEvent<{
  version: string;
  updateInfo: UpdateInfo;
}>('update:available');

export const updateNotAvailableEvent = defineEvent<void>('update:not-available');

export const updateDownloadingEvent = defineEvent<{ version: string }>('update:downloading');

export const updateProgressEvent = defineEvent<{
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}>('update:progress');

export const updateDownloadedEvent = defineEvent<{ version: string }>('update:downloaded');

export const updateInstallingEvent = defineEvent<void>('update:installing');

/**
 * An install did not happen: the installer failed, the app came back on the old
 * version, or this copy of the app cannot be updated in place. The update has
 * to be downloaded by hand.
 */
export const updateInstallFailedEvent = defineEvent<{
  version: string;
  message: string;
  /** Found on the launch after a handover, rather than while someone watched. */
  foundAtLaunch: boolean;
}>('update:install-failed');

export const updateErrorEvent = defineEvent<{ message: string }>('update:error');
