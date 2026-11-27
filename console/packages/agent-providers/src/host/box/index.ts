/**
 * `@switch-console/agent-providers/box`: what a hosted agents box's
 * controller takes from the agent host's box-only modules. A subpath of its
 * own, never the package's main index, so nothing Console or a self-installed machine
 * imports loads box code. Import it only from code that runs in box mode.
 */
export {
  BoxValve,
  type BoxValveStatus,
  boxCap,
  CAP_HEADROOM,
  CONTROLLER_RESTING_BYTES,
  SESSION_ALLOWANCE_BYTES,
  type ValveEvent,
} from './box-valve';
export { HubHostValve, HubValveChannel } from './box-valve-client';
export { isValveFrame, ValveServer } from './box-valve-wire';
export { boxLimitFromEnv, readUsage, startReserveFromEnv } from './memory-pressure';
export { OWNER_MARKER_ENV } from './owner-marker-env';
export { judgeOwnerRecord, recordedOwnerAlive } from './owner-records';
export { supervisionBox } from './supervision';
export { HubTickets } from './watcher-box';
export { macEquals, PUSH_KEY_BYTES, takenMac, ticketMac } from './push-key';
export type { RestartNotice } from '../watcher-tools';
