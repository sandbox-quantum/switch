import {
  commandStatusSchema,
  attachmentSchema,
  serverEventSchema,
  type SessionTransport,
} from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { rpc } from '@renderer/lib/ipc';

export function sharedSessionTransport(serverId: string): SessionTransport {
  return {
    uploadAttachment: async (sessionId, file) => {
      const value = await rpc.sdkHost.uploadAttachment(serverId, sessionId, file);
      return attachmentSchema.parse(value);
    },
    snapshot: (id) => rpc.sdkHost.sharedSnapshot(serverId, id),
    submit: async (command) =>
      commandStatusSchema.parse(await rpc.sdkHost.sharedSubmit(serverId, command)),
    commandStatus: async (id, commandId) =>
      commandStatusSchema.parse(await rpc.sdkHost.sharedCommandStatus(serverId, id, commandId)),
    subscribe(id, after, onEvent, onError, onCursor) {
      let stopped = false;
      let cursor = after;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const poll = async () => {
        try {
          const events = z
            .array(serverEventSchema)
            .parse(await rpc.sdkHost.sharedEvents(serverId, id, cursor));
          if (stopped) return;
          for (const event of events) {
            onEvent(event);
            cursor = event.sequence;
          }
          onCursor(cursor);
          timer = setTimeout(() => void poll(), 500);
        } catch (error) {
          if (!stopped) onError(error instanceof Error ? error : new Error(String(error)));
        }
      };
      void poll();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
    },
  };
}
