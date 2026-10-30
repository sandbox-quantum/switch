import { accountLifecycle } from "./account-lifecycle.ts";
import { agentIdentity } from "./agent-identity.ts";
import { attachmentNames } from "./attachments.ts";
import { clientMistakes } from "./client-mistakes.ts";
import { endSessions, memberErasure, retentionWindow } from "./data-protection.ts";
import { consoleChatRoundtrip } from "./console-chat-roundtrip.ts";
import { followUps } from "./follow-ups.ts";
import { addressedDelivery, unaddressedHistory } from "./agent-messaging.ts";
import { operationsFrontDoor } from "./operations.ts";
import { organizationMembers } from "./organization-members.ts";
import { organizations } from "./organizations.ts";
import { roomCapture } from "./room-capture.ts";
import { roomGroupPaths } from "./room-groups.ts";
import type { FastScenario } from "./scenario.ts";

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
  organizationMembers,
  organizations,
  accountLifecycle,
  retentionWindow,
  memberErasure,
  endSessions,
];
