/**
 * Box mode only: the `SupervisionBox` a box's agent host supervises its
 * session hosts with. Loaded only through a dynamic import behind `options.box`.
 */
import type { SupervisionBox } from '../launch';
import {
  boxProcessCommandLine,
  boxTicketJudge,
  judgeOwnerRecord,
  recordFolder,
} from './owner-records';
import { markStopAsked } from './stop-asked';

export function supervisionBox(input: {
  /** An agents controller's owner marker, added to each host's environment. */
  extraEnv: Record<string, string>;
  /** False in a split box, whose launcher, not the supervisor, restarts a crashed worker. */
  selfRestart: boolean;
  pushKey?: Buffer;
  unsureLimitMs?: number;
}): SupervisionBox {
  return {
    judge: (path, pid) => judgeOwnerRecord(path, pid),
    ticketJudge: boxTicketJudge,
    selfRestart: input.selfRestart,
    ...(input.pushKey ? { pushKey: input.pushKey } : {}),
    ...(input.unsureLimitMs === undefined ? {} : { unsureLimitMs: input.unsureLimitMs }),
    recordFolder,
    commandLine: boxProcessCommandLine,
    markStopAsked,
    extraEnv: input.extraEnv,
  };
}
