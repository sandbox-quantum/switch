import { defineEvent } from '@shared/lib/ipc/events';

/**
 * Emitted when a session's Switch room connection changes. `roomId`/`agentId`
 * are null when the session is no longer connected to any room (switched away
 * or exited).
 */
export const sessionRoomChangedChannel = defineEvent<{
  sessionId: string;
  roomId: string | null;
  agentId: string | null;
}>('switch-room:session-room-changed');

/**
 * Emitted by the main process when the app is opened via a
 * `switchdash://session?…` deeplink (from a messaging-app message). The renderer
 * resolves the live session for this server+agent+room and navigates to it.
 * `server` is the originating gateway's public base URL.
 */
export const sessionDeeplinkChannel = defineEvent<{
  server: string;
  agentId: string;
  roomId: string;
  /** Shared session id, preferred for resolution (resolves on any client);
   * empty string for links from older builds that only carried the room. */
  sessionId: string;
  /**
   * Whether the link started the app rather than being handed to a running one.
   * Known only in the main process; carried here because whether the link
   * resolved is known only in the renderer, and both belong to one event.
   */
  coldStart: boolean;
}>('switch-room:session-deeplink');
