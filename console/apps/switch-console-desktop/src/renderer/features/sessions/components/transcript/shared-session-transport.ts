import {
  commandStatusSchema,
  attachmentSchema,
  serverEventSchema,
  type SessionTransport,
} from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { rpc } from '@renderer/lib/ipc';

type Poll = (sessionId: string, after: number) => Promise<unknown>;

function polling(read: Poll): SessionTransport['subscribe'] {
  return (id, after, onEvent, onError, onCursor) => {
    let stopped = false;
    let cursor = after;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const events = z.array(serverEventSchema).parse(await read(id, cursor));
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
  };
}

/**
 * The transcript read from the session host's own journal, with every command
 * still sent through Switch: the host takes commands only from Switch.
 * Sequence numbers here are the host's, so a client built on this transport
 * never mixes in events read from Switch.
 */
export function hostJournalTransport(agentId: string, serverId: string): SessionTransport {
  return {
    ...sharedSessionTransport(serverId),
    snapshot: (id) => rpc.sdkHost.journalSnapshot(agentId, id),
    subscribe: polling((id, after) => rpc.sdkHost.journalEvents(agentId, id, after)),
  };
}

export function sharedSessionTransport(serverId: string): SessionTransport {
  return {
    uploadAttachment: async (sessionId, file) => {
      const value = await rpc.sdkHost.uploadAttachment(serverId, sessionId, file);
      return attachmentSchema.parse(value);
    },
    snapshot: (id) => rpc.sdkHost.sharedSnapshot(serverId, id),
    submit: async (command) =>
      commandStatusSchema.parse(await rpc.sdkHost.sharedSubmit(serverId, command)),
    reconcile: async (command) =>
      commandStatusSchema.parse(await rpc.sdkHost.sharedReconcile(serverId, command)),
    commandStatus: async (id, commandId) =>
      commandStatusSchema.parse(await rpc.sdkHost.sharedCommandStatus(serverId, id, commandId)),
    subscribe: polling((id, after) => rpc.sdkHost.sharedEvents(serverId, id, after)),
  };
}
