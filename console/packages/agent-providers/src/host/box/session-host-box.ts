/**
 * Box mode only: the `SessionHostBox` a box's session host runs with.
 * Loaded only through a dynamic import behind `options.box`.
 */
import type { SessionReplica, Snapshot } from '@switch-console/shared/session-v1';
import type { SessionHostBox } from '../session-host';
import {
  addRestartReplyRound,
  RESTART_REPLY_ROUNDS,
  restartReplyGivenUp,
  restartReplyRounds,
} from './restart-rounds';
import { clearStopAsked, stopWasAsked } from './stop-asked';
import { ViewableReplica } from './viewable-replica';

export const sessionHostBox: SessionHostBox = {
  newReplica: (snapshot: Snapshot) => new ViewableReplica(snapshot),
  view: (replica: SessionReplica) =>
    replica instanceof ViewableReplica ? replica.view() : replica.snapshot(),
  stopWasAsked,
  clearStopAsked,
  restartReplyRounds,
  restartReplyGivenUp,
  addRestartReplyRound,
  restartReplyRoundsLimit: RESTART_REPLY_ROUNDS,
};
