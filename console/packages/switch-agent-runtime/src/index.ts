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
 * Imported by Switch Console (which submits them to a session's SDK adapter)
 * and by this package's own MCP runtime (which serves them next to the agent).
 * It exists because those two had a copy each and the copies drifted within a
 * day.
 *
 * The MCP runtime is in separate entry points — `./hosted`, the tool surface a
 * session host serves and its watcher runs, and `./bin`, the standalone
 * binary — so importing the client does not drag in the MCP SDK.
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
  findOrphanedRuntimes,
  parseProcessTable,
  reapOrphanedRuntimes,
  staleSessionDirs,
  type ProcessRow,
  type ReapOutcome,
} from './reap';
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
