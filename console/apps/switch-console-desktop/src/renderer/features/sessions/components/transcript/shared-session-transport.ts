import {
  commandStatusSchema,
  serverEventSchema,
  type SessionTransport,
} from '@switch-console/shared/session-v1';
import { events, rpc } from '@renderer/lib/ipc';
import {
  sessionTranscriptEventChannel,
  sessionTranscriptResetChannel,
} from '@shared/core/sessions/sessionEvents';

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
      const offReset = events.on(
        sessionTranscriptResetChannel,
        ({ reason }) => onError(new Error(`The live feed from the session stopped (${reason}).`)),
        id
      );
      onCursor(cursor);
      return () => {
        off();
        offReset();
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

/**
 * A cloud agent's session: the same host journal as `hostJournalTransport`,
 * reached through the Switch server's relay to the launch's worker. Files go
 * up to the worker in chunks and are staged there for the next message.
 */
export function cloudSessionTransport(agentKey: string): SessionTransport {
  return {
    ...hostJournalTransport(agentKey),
    uploadAttachment: (id, file) =>
      rpc.sdkHost.cloudUploadAttachment(agentKey, id, {
        name: file.name,
        mimeType: file.mimeType,
        data: file.data,
      }),
  };
}
