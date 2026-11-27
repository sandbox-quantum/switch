/**
 * Box mode only: what `shared-daemon` runs with in a box. Loaded only through
 * a dynamic import behind box mode (the image's marker, `box-mode.ts`).
 */
import { HubValveChannel } from './box-valve-client';
import { readPushKey } from './push-key';
import { supervisionBox } from './supervision';
import { HubTickets } from './watcher-box';

export { longRunning, stampConsole } from './log-stamp';
export { NotSignedInError, recordedKindOf } from './start-failure';
export { HubTickets, HubValveChannel, readPushKey, supervisionBox };

/**
 * Whether the launcher starts hosts on this box (a split box): a push key on
 * the launcher's pipe, and a one-time ticket for each hub hello.
 */
export function launcherStartsHosts(env: NodeJS.ProcessEnv): boolean {
  return env.SWITCH_HUB_TICKETS === '1';
}
