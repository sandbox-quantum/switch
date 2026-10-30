import { KV } from '@main/db/kv';

/**
 * That an update was handed to the installer, remembered across the restart.
 *
 * An install that works ends this process, so the only way to report that one
 * happened is to write it down first and read it back in the process that comes
 * after. The marker is set immediately before the handover and cleared by the
 * rollback, so on the next launch its presence means the app really did go down
 * for an installer rather than unwinding back to "ready to install".
 *
 * It records the version being installed, because going down for the installer
 * is not the same as coming back on the new version: on macOS, Squirrel.Mac can
 * fail to replace the bundle and relaunch the old one without a word.
 */
const store = new KV<{
  /** Written by builds that did not record a target version. */
  handover: boolean;
  target: string;
}>('updates:pending-install');

export interface PendingHandover {
  /** The version handed to the installer; null for a marker an older build wrote. */
  targetVersion: string | null;
}

export const pendingInstall = {
  set: (targetVersion: string): Promise<void> => store.set('target', targetVersion),

  clear: async (): Promise<void> => {
    await store.del('target');
    await store.del('handover');
  },

  /**
   * The handover the previous run made, if any, clearing the record so a launch
   * is only ever counted once. Cleared before the caller reports, so a report
   * that fails to send loses one event rather than repeating it on every launch
   * from here on.
   */
  async take(): Promise<PendingHandover | null> {
    const target = await store.get('target');
    const legacy = await store.get('handover');
    if (typeof target !== 'string' && legacy !== true) return null;
    await pendingInstall.clear();
    return { targetVersion: typeof target === 'string' ? target : null };
  },
};
