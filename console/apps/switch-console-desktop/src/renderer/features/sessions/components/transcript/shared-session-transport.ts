import {
  commandStatusSchema,
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
 * A shared session as its host records it: the transcript from the host's own
 * journal, and every command through Switch's relay, the only place the host
 * takes commands from. Sequence numbers are the host's own.
 *
 * No attachment upload: the host takes files only from the rooms it is
 * addressed in, so the composer says attachments are unavailable here.
 */
export function hostJournalTransport(agentId: string): SessionTransport {
  return {
    snapshot: (id) => rpc.sdkHost.journalSnapshot(agentId, id),
    subscribe: polling((id, after) => rpc.sdkHost.journalEvents(agentId, id, after)),
    submit: async (command) =>
      commandStatusSchema.parse(await rpc.sdkHost.sessionSubmit(agentId, command)),
    reconcile: async (command) =>
      commandStatusSchema.parse(await rpc.sdkHost.sessionReconcile(agentId, command)),
    commandStatus: async (id, commandId) =>
      commandStatusSchema.parse(await rpc.sdkHost.sessionCommandStatus(agentId, id, commandId)),
  };
}
