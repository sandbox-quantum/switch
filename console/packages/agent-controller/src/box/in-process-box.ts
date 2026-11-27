import {
  HubTickets,
  judgeOwnerRecord,
  recordedOwnerAlive,
  type RestartNotice,
  supervisionBox,
} from '@switch-console/agent-providers/box';
import type { InProcessBox } from '../runtime';

/**
 * Box mode only: what a box's agent hosts do beyond upstream's, for
 * `InProcessRuntime` (`InProcessBox`). Loaded only through a dynamic import
 * inside a box-mode branch, never by Switch Console or a self-installed machine.
 */
export function inProcessBox(input: {
  /** Where an agent's watcher posts its restart line keyed by its turn; absent: it has none. */
  restartNotice: (agentId: string) => RestartNotice | undefined;
  /** The owner marker each agent's session hosts carry in their environment. */
  ownerEnv: (agentId: string) => Record<string, string>;
}): InProcessBox {
  return {
    watcher: (agentId) => ({
      restartNotice: input.restartNotice(agentId),
      tickets: new HubTickets(),
    }),
    supervision: (agentId) =>
      supervisionBox({ extraEnv: input.ownerEnv(agentId), selfRestart: true }),
    recordedOwnerAlive,
    judgeOwnerRecord,
  };
}
