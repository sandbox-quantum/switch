import { accountLifecycle } from './account-lifecycle.ts';
import { agentIdentity } from './agent-identity.ts';
import { addressedDelivery, unaddressedHistory } from './agent-messaging.ts';
import { agentRooms } from './agent-rooms.ts';
import { attachmentNames } from './attachments.ts';
import { clientMistakes } from './client-mistakes.ts';
import { endSessions, memberErasure, retentionWindow } from './data-protection.ts';
import { decisionSettings } from './decision-settings.ts';
import { followUps } from './follow-ups.ts';
import { mattermostRoundtrip } from './mattermost-roundtrip.ts';
import { operationsFrontDoor } from './operations.ts';
import { organizationMembers } from './organization-members.ts';
import { organizations } from './organizations.ts';
import { roomCapture } from './room-capture.ts';
import { roomGroupPaths } from './room-groups.ts';
import { roomScheduleTools } from './room-schedule-tools.ts';
import { roomSchedules } from './room-schedules.ts';
import type { FastScenario } from './scenario.ts';

/** Every fast-lane scenario. A scenario not listed here does not run. */
export const FAST_SCENARIOS: readonly FastScenario[] = [
  addressedDelivery,
  unaddressedHistory,
  operationsFrontDoor,
  mattermostRoundtrip,
  agentIdentity,
  roomGroupPaths,
  agentRooms,
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
  decisionSettings,
  roomSchedules,
  roomScheduleTools,
];
