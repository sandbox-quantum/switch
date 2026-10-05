import { SessionChatClient } from '@switch-console/shared/session-v1';
import { useEffect, useState } from 'react';
import { SessionRoomConnection } from '@renderer/features/switch-rooms/session-room-connection';
import { rpc } from '@renderer/lib/ipc';
import type { InitialPromptDelivery } from '@shared/core/sessions/session-config';
import { SessionV1Chat } from './session-v1-chat';
import { hostJournalTransport } from './shared-session-transport';

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
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [startup, setStartup] = useState<{
    status: 'starting' | 'ready' | 'error';
    message: string | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const check = async () => {
      if (pending) return;
      pending = true;
      try {
        const status = await rpc.sdkHost.startupStatus(sessionId);
        if (!cancelled) setStartup(status);
      } catch (error) {
        if (!cancelled)
          setStartup({
            status: 'error',
            message: `Could not check session startup: ${String(error)}`,
          });
      } finally {
        pending = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);
  // Asked again once the host is up: a journal that did not exist while the
  // host was starting may be readable now.
  const hostReady = startup?.status === 'ready';
  useEffect(() => {
    let cancelled = false;
    setClient(null);
    setError(null);
    setUnreachable(null);
    void (async () => {
      const source = await rpc.sdkHost.transcriptSource(agentId, sessionId);
      if (cancelled) return;
      if (source.kind === 'unreachable') setUnreachable(source.reason);
      else setClient(new SessionChatClient(sessionId, hostJournalTransport(agentId)));
    })().catch((error: unknown) => {
      if (!cancelled) setError(String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, sessionId, hostReady]);
  if (error)
    return (
      <div role="alert" className="p-5 text-foreground-destructive">
        {error}
      </div>
    );
  if (unreachable)
    return (
      <div role="status" className="p-5 text-foreground-muted">
        This session’s transcript is kept by its host, and it cannot be read from here:{' '}
        {unreachable}
      </div>
    );
  return client ? (
    <div className="flex h-full min-h-0 flex-col">
      <SessionRoomConnection
        sessionId={sessionId}
        agentId={agentId}
        startupStatus={startup?.status}
      />
      <SessionV1Chat
        client={client}
        startup={startup}
        hostState={null}
        stopHost={() => rpc.sdkHost.stop(agentId, sessionId)}
        initialPromptDelivery={initialPromptDelivery}
        restartHost={() => rpc.sessions.restartAgent(sessionId)}
      />
    </div>
  ) : (
    <div role="status" className="p-5">
      Connecting to session…
    </div>
  );
}
