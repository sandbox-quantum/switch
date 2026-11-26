import { type BoxValve, isValveFrame, ValveServer } from '@switch-console/agent-providers/box';
import type { HubValve } from '../hub-socket';

/**
 * Box mode only: the box valve as the hub serves it (`HubSocket`'s `valve`).
 * Desktop never loads this module, so the box valve stays out of its build.
 */
export function boxHubValve(input: {
  valve: BoxValve;
  ready: Promise<void>;
  trusted: HubValve['trusted'];
  share: () => number;
}): HubValve & { valve: BoxValve } {
  return {
    ...input,
    isFrame: isValveFrame,
    join: ({ agentId, send, log, share }) =>
      new ValveServer({ valve: input.valve, agentId, send, log, share }),
  };
}
