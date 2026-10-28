import { agentIdentity } from "./agent-identity.ts";
import { addressedDelivery, unaddressedHistory } from "./agent-messaging.ts";
import { mattermostRoundtrip } from "./mattermost-roundtrip.ts";
import { operationsFrontDoor } from "./operations.ts";
import type { FastScenario } from "./scenario.ts";

/** Every fast-lane scenario. A scenario not listed here does not run. */
export const FAST_SCENARIOS: readonly FastScenario[] = [
  addressedDelivery,
  unaddressedHistory,
  operationsFrontDoor,
  mattermostRoundtrip,
  agentIdentity,
];
