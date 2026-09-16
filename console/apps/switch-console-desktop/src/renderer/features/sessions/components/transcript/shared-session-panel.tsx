import { SessionChatClient } from '@switch-console/shared/session-v1';
import { useEffect, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import type { InitialPromptDelivery } from '@shared/core/sessions/session-config';
import { SessionV1Chat } from './session-v1-chat';
import { sharedSessionTransport } from './shared-session-transport';

export function SharedSessionPanel({
  sessionId,
  agentId,
  initialPromptDelivery,
}: {
  sessionId: string;
  agentId: string;
  initialPromptDelivery: InitialPromptDelivery | undefined;
}) {
  const [client, setClient] = useState<SessionChatClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const check = async () => {
      if (pending) return;
      pending = true;
      try {
        const status = await rpc.sdkHost.startupStatus(sessionId);
        if (!cancelled) setStartupError(status?.status === 'error' ? status.message : null);
      } catch (error) {
        if (!cancelled) setStartupError(`Could not check session startup: ${String(error)}`);
      } finally {
        pending = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);
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
    <div className="flex h-full min-h-0 flex-col">
      {startupError && (
        <div role="alert" className="border-b border-border px-5 py-3 text-foreground-destructive">
          Session startup failed: {startupError}
        </div>
      )}
      <SessionV1Chat
        client={client}
        initialPromptDelivery={initialPromptDelivery}
        restartHost={() => rpc.sessions.restartAgent(sessionId)}
        retireHost={async (epoch) => {
          const serverId = await rpc.sdkHost.serverForAgent(agentId);
          await rpc.sdkHost.retire(serverId, sessionId, epoch);
        }}
      />
    </div>
  ) : (
    <div role="status" className="p-5">
      Connecting to session…
    </div>
  );
}
