import { SessionChatClient } from '@switch-console/shared/session-v1';
import { useEffect, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { SessionV1Chat } from './session-v1-chat';
import { sharedSessionTransport } from './shared-session-transport';

export function SharedSessionPanel({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const [client, setClient] = useState<SessionChatClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setClient(null);
    setError(null);
    void rpc.sdkHost
      .serverForAgent(agentId)
      .then((serverId) => {
        if (!cancelled)
          setClient(new SessionChatClient(sessionId, sharedSessionTransport(serverId)));
      })
      .catch((error: unknown) => {
        if (!cancelled) setError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, sessionId]);
  if (error)
    return (
      <div role="alert" className="p-5 text-foreground-destructive">
        {error}
      </div>
    );
  return client ? (
    <SessionV1Chat
      client={client}
      restartHost={() => rpc.sessions.restartAgent(sessionId)}
      retireHost={async (epoch) => {
        const serverId = await rpc.sdkHost.serverForAgent(agentId);
        await rpc.sdkHost.retire(serverId, sessionId, epoch);
      }}
    />
  ) : (
    <div role="status" className="p-5">
      Connecting to session…
    </div>
  );
}
