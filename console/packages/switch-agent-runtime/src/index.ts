/**
 * The Switch agent protocol client.
 *
 * One connection to Switch: an SSE stream carrying events, a heartbeat proving
 * the client is alive, and a cursor so a reconnect resumes exactly where it
 * stopped. Everything a process needs to be reachable as an agent, and nothing
 * about what it then does with the events — injecting them into a terminal,
 * surfacing them as MCP notifications, or deciding to start a session are all
 * the consumer's business.
 *
 * Imported by Switch Console (which delivers into a session's pane) and by this
 * package's own MCP runtime (which serves them next to the agent). It exists
 * because those two had a copy each and the copies drifted within a day.
 *
 * The MCP runtime is a separate entry point (`./bin`) so importing the client
 * does not drag in the MCP SDK.
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
  SwitchEventStream,
  type DeliveryFilter,
  type EventStreamLogger,
  type StreamScope,
  type SwitchEventStreamDeps,
} from './event-stream';
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
