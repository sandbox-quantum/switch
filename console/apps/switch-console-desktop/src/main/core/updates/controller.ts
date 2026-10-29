import { app, shell } from 'electron';
import type { TelemetryUpdateTrigger } from '@main/core/telemetry/events';
import { updateService } from '@main/core/updates/update-service';
import { IS_CANARY } from '@shared/app-identity';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { manualDownloadUrl } from './manual-download';
import { formatUpdaterError } from './utils';

export const updateController = createRPCController({
  check: async (trigger: TelemetryUpdateTrigger = 'user') => {
    try {
      const result = await updateService.checkForUpdates(trigger);
      return { success: true, result: result ?? null };
    } catch (error) {
      return { success: false, error: formatUpdaterError(error) };
    }
  },

  download: async () => {
    try {
      await updateService.downloadUpdate();
      return { success: true };
    } catch (error) {
      return { success: false, error: formatUpdaterError(error) };
    }
  },

  quitAndInstall: async () => {
    try {
      updateService.quitAndInstall();
      return { success: true };
    } catch (error) {
      return { success: false, error: formatUpdaterError(error) };
    }
  },

  /**
   * Hand the update to the user: open the page of this channel's newest release
   * and quit, so the app can be replaced while it is not running.
   */
  openLatest: async () => {
    try {
      await shell.openExternal(await manualDownloadUrl(IS_CANARY));
      setTimeout(() => {
        try {
          app.quit();
        } catch {}
      }, 500);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  openReleaseNotes: async () => {
    try {
      await shell.openExternal(await updateService.releaseNotesUrl());
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  getState: async () => {
    try {
      const state = updateService.getState();
      return { success: true, data: state };
    } catch (error) {
      return { success: false, error: formatUpdaterError(error) };
    }
  },
});
