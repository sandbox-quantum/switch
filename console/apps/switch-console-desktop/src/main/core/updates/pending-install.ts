import { KV } from '@main/db/kv';

/**
 * That an update was handed to the installer, remembered across the restart.
 *
 * An install that works ends this process, so the only way to report that one
 * happened is to write it down first and read it back in the process that comes
 * after. The marker is set immediately before the handover and cleared when an
 * install attempt is abandoned, so on the next launch its presence means the app
 * really did go down for an installer rather than unwinding back to "ready to install".
 *
 * It records the version being installed and the version it replaces, because
 * going down for the installer is not the same as coming back on the new
 * version: on macOS, Squirrel.Mac can fail to replace the bundle and relaunch
 * the old one without a word.
 */
const store = new KV<{
  /** Written by builds that did not record a target version. */
  handover: boolean;
  target: string;
  from: string;
}>('updates:pending-install');

export interface PendingHandover {
  /** The version handed to the installer; null for a marker an older build wrote. */
  targetVersion: string | null;
  /** The version that handed over; null for a marker an older build wrote. */
  fromVersion: string | null;
}

/** This run's answer, once anything has asked. */
let taken: Promise<PendingHandover | null> | null = null;

export const pendingInstall = {
  /**
   * Record a handover. Throws when the write fails, because a handover with no
   * record can fail without anyone finding out.
   */
  set: async (targetVersion: string, fromVersion: string): Promise<void> => {
    await store.setOrThrow('target', targetVersion);
    await store.setOrThrow('from', fromVersion);
  },

  clear: (): Promise<void> => store.clear(),

  /**
   * The handover the previous run made, if any, clearing the record so a launch
   * is only ever counted once. Cleared before the caller reports, so a report
   * that fails to send loses one event rather than repeating it on every launch
   * from here on.
   *
   * The same answer for every caller in this run: the update service reports
   * the handover and the launch report says which kind of install it was, and
   * whichever asks first must not leave the other reading a cleared record.
   */
  take(): Promise<PendingHandover | null> {
    taken ??= (async () => {
      const target = await store.get('target');
      const from = await store.get('from');
      const legacy = await store.get('handover');
      if (typeof target !== 'string' && legacy !== true) return null;
      await pendingInstall.clear();
      return {
        targetVersion: typeof target === 'string' ? target : null,
        fromVersion: typeof from === 'string' ? from : null,
      };
    })();
    return taken;
  },
};
