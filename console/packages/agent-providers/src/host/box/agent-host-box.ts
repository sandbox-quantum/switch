/**
 * Box mode only: everything a box's agent host (`agent-host.ts`) uses that
 * Console's own hosts don't. Loaded only through a dynamic import behind
 * `options.box`, so Console never loads it.
 */
export {
  DirectHostValve,
  fallbackFromEnv,
  giveUpReasonOf,
  HubHostValve,
  LegacyHostValve,
  refusalText,
  waitRequestOf,
} from './box-valve-client';
export { HeldReplies, OwedLostLines } from './held-replies';
export { BoxFullError, pressureValve } from './memory-pressure';
export { recordedOwnerAlive } from './owner-records';
export { owesRestartReply } from './restart-rounds';
export {
  RESET_WHILE_WAITING_MESSAGE,
  roomWaits,
  SLOW_START_RETRY_MS,
  STOPPED_WAITING_MESSAGE,
  WAITING_FOR_ROOM_MESSAGE,
} from './room-wait';
export {
  keptLine,
  readStartFailureKind,
  SESSION_CLOSED_MESSAGE,
  START_LET_GO_MESSAGE,
} from './start-failure';
export { sessionStarts, untilReady } from './start-limiter';
export {
  announceBoxFull,
  announceKept,
  HubTickets,
  tellRoomReplyLost,
  watcherBox,
} from './watcher-box';
