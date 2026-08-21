import { app, shell } from 'electron';
import type { TelemetryUpdateTrigger } from '@main/core/telemetry/events';
import { updateService } from '@main/core/updates/update-service';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { SWITCH_CONSOLE_RELEASES_URL } from '@shared/urls';
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

  openLatest: async () => {
    try {
      await shell.openExternal(SWITCH_CONSOLE_RELEASES_URL);
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

  getState: async () => {
    try {
      const state = updateService.getState();
      return { success: true, data: state };
    } catch (error) {
      return { success: false, error: formatUpdaterError(error) };
    }
  },

  getReleaseNotes: async () => {
    try {
      const notes = await updateService.fetchReleaseNotes();
      return { success: true, data: notes };
    } catch (error) {
      return { success: false, error: formatUpdaterError(error) };
    }
  },
});
