import {
  commandStatusSchema,
  serverEventSchema,
  type SessionTransport,
} from '@switch-console/shared/session-v1';
import { events, rpc } from '@renderer/lib/ipc';
import { sessionTranscriptEventChannel } from '@shared/core/sessions/sessionEvents';

/**
 * A shared session as its host records it: the snapshot and every event after
 * it pushed from Console's main process, which has them from the host itself,
 * and every command sent to the host the same way. Sequence numbers are the
 * host's own.
 *
 * No attachment upload: the host takes files only from the rooms it is
 * addressed in, so the composer says attachments are unavailable here.
 */
export function hostJournalTransport(agentId: string): SessionTransport {
  return {
    snapshot: (id) => rpc.sdkHost.transcriptOpen(agentId, id),
    subscribe(id, after, onEvent, onError, onCursor) {
      let cursor = after;
      const off = events.on(
        sessionTranscriptEventChannel,
        ({ event }) => {
          const parsed = serverEventSchema.safeParse(event);
          if (!parsed.success) {
            onError(
              new Error(`The session host sent an unreadable event: ${parsed.error.message}`)
            );
            return;
          }
          if (parsed.data.sequence <= cursor) return;
          onEvent(parsed.data);
          cursor = parsed.data.sequence;
          onCursor(cursor);
        },
        id
      );
      onCursor(cursor);
      return () => {
        off();
        void rpc.sdkHost.transcriptClose(id);
      };
    },
    submit: async (command) =>
      commandStatusSchema.parse(await rpc.sdkHost.sessionSubmit(agentId, command)),
    reconcile: async (command) =>
      commandStatusSchema.parse(await rpc.sdkHost.sessionReconcile(agentId, command)),
    commandStatus: async (id, commandId) =>
      commandStatusSchema.parse(await rpc.sdkHost.sessionCommandStatus(agentId, id, commandId)),
  };
}
