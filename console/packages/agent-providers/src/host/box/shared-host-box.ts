/**
 * Box mode only: what a box's session host process runs with beyond Console's.
 * Loaded only through `loadSharedHostBox`, a dynamic import behind `options.box`.
 */
import type { SharedConfigBox } from '../shared-config';
import type { SharedHostBox } from '../shared-host';
import { withOwnerMarker, withoutPlantedMarkers } from './owner-marker-env';
import { boxFenceDeadOwner, boxTicketJudge } from './owner-records';
import { sessionHostBox } from './session-host-box';

export const sharedHostBox: SharedHostBox = {
  session: sessionHostBox,
  fenceDeadOwner: (pid, group, startedAt, lock) => boxFenceDeadOwner(pid, group, startedAt, lock),
  ticketJudge: boxTicketJudge,
};

export const sharedConfigBox: SharedConfigBox = { withOwnerMarker, withoutPlantedMarkers };
