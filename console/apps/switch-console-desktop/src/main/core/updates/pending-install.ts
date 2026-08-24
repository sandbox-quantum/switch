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
 * It says only that a handover happened — not that the new version is running.
 * That question is answered by the version `app_launched` carries.
 */
const store = new KV<Record<string, boolean>>('updates:pending-install');

const KEY = 'handover';

export const pendingInstall = {
  set: (): Promise<void> => store.set(KEY, true),
  clear: (): Promise<void> => store.del(KEY),

  /**
   * Whether the previous run handed an update over, clearing the record so a
   * launch is only ever counted once. Cleared before the caller reports, so a
   * report that fails to send loses one event rather than repeating it on every
   * launch from here on.
   */
  async take(): Promise<boolean> {
    if ((await store.get(KEY)) !== true) return false;
    await store.del(KEY);
    return true;
  },
};
