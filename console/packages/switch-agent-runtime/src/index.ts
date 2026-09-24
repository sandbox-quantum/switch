/**
 * The Switch agent protocol client.
 *
 * One connection to Switch: an SSE stream carrying events, a heartbeat proving
 * the client is alive, and a cursor so a reconnect resumes exactly where it
 * stopped. Everything a process needs to be reachable as an agent, and nothing
 * about what it then does with the events — submitting them to a session,
 * surfacing them as MCP notifications, or deciding to start a session are all
 * the consumer's business.
 *
 * Imported by Switch Console and the agent sidecar, which submit them to a
 * session's SDK adapter.
 *
 * The tool surface a session host serves and its watcher runs is a separate
 * entry point, `./hosted`, so importing the client does not drag in the MCP
 * SDK.
 */

export {
  ARTIFACT_VERSIONS,
  artifactVersion,
  CONTRACTS,
  contractRange,
  type ArtifactName,
  type ContractName,
  type ContractRange,
} from './artifacts';
export {
  BEAT_INTERVAL_MS,
  EVICTION_CLOSED,
  EVICTION_CREDENTIALS_REJECTED,
  EVICTION_HEARTBEAT_LAPSED,
  EVICTION_TAKEN_OVER,
  PlacementsRefusedError,
  SwitchEventStream,
  type ApprovalOutcome,
  type SessionCommand,
  type DeliveryFilter,
  type EventStreamLogger,
  type Eviction,
  type StreamScope,
  type SwitchEventStreamDeps,
} from './event-stream';
export {
  RoomAdmissionError,
  SwitchRoomAdmissions,
  type CarriedRooms,
  type RefusedRoom,
  type RoomAdmission,
  type RoomDelivery,
  type RoomReservation,
} from './room-admission';
export { readSse, type SseFrame } from './sse';
export type {
  AgentBridgeEvent,
  AttachmentRef,
  CommandPayload,
  MessagePayload,
  RoomJoinPayload,
  SwitchCredentials,
  TaskPayload,
} from './types';
