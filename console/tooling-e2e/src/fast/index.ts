import { agentIdentity } from './agent-identity.ts';
import { addressedDelivery, unaddressedHistory } from './agent-messaging.ts';
import { attachmentNames } from './attachments.ts';
import { clientMistakes } from './client-mistakes.ts';
import { consoleChatRoundtrip } from './console-chat-roundtrip.ts';
import { followUps } from './follow-ups.ts';
import { operationsFrontDoor } from './operations.ts';
import { roomCapture } from './room-capture.ts';
import { roomGroupPaths } from './room-groups.ts';
import type { FastScenario } from './scenario.ts';

/** Every fast-lane scenario. A scenario not listed here does not run. */
export const FAST_SCENARIOS: readonly FastScenario[] = [
  addressedDelivery,
  unaddressedHistory,
  operationsFrontDoor,
  consoleChatRoundtrip,
  agentIdentity,
  roomGroupPaths,
  attachmentNames,
  clientMistakes,
  roomCapture,
  followUps,
];
