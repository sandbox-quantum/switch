import {
  SessionChatClient,
  commandStatusSchema,
  serverEventSchema,
  sessionSchema,
} from '@switch-console/shared/session-v1';
import type { SessionTransport } from '@switch-console/shared/session-v1';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { SessionV1Chat } from './session-v1-chat';

function transport(serverId: string): SessionTransport {
  return {
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

export function SharedSessionWorkbench() {
  const [servers, setServers] = useState<{ id: string; name: string }[]>([]);
  const [serverId, setServerId] = useState('');
  const [sessions, setSessions] = useState<z.infer<typeof sessionSchema>[]>([]);
  const [client, setClient] = useState<SessionChatClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    void rpc.switchServers
      .listServers()
      .then(setServers, (error: unknown) => setError(String(error)));
  }, []);
  useEffect(() => {
    let cancelled = false;
    setClient(null);
    setSessions([]);
    setError(null);
    if (serverId)
      void rpc.sdkHost
        .sharedList(serverId)
        .then((value) => {
          const next = z.array(sessionSchema).parse(value);
          if (!cancelled) setSessions(next);
        })
        .catch((error: unknown) => {
          if (!cancelled) setError(String(error));
        });
    return () => {
      cancelled = true;
    };
  }, [serverId, refresh]);
  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex items-center gap-3 border-b border-border p-4">
        <select
          aria-label="Switch server"
          value={serverId}
          onChange={(event) => setServerId(event.target.value)}
          className="rounded border border-border bg-background p-2"
        >
          <option value="">Choose a Switch server</option>
          {servers.map((server) => (
            <option key={server.id} value={server.id}>
              {server.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Shared sessions"
          value={client?.sessionId ?? ''}
          onChange={(event) => {
            if (event.target.value)
              setClient(new SessionChatClient(event.target.value, transport(serverId)));
          }}
          className="rounded border border-border bg-background p-2"
        >
          <option value="">Choose a shared session</option>
          {sessions.map((session) => (
            <option key={session.sessionId} value={session.sessionId}>
              {session.provider} · {session.sessionId.slice(0, 8)} · {session.connectivity}
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          disabled={!serverId}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="p-4 text-foreground-destructive">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {client ? (
          <SessionV1Chat key={`${serverId}/${client.sessionId}`} client={client} />
        ) : (
          <p className="p-8 text-foreground-muted">
            Choose a session owned by your signed-in account. Approval results appear here and on
            the request card.
          </p>
        )}
      </div>
    </div>
  );
}
