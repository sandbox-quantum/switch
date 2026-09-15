import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';

export function SidecarSettingsSection({ agentId }: { agentId: string }) {
  const query = useQuery({
    queryKey: ['shared-host', agentId],
    queryFn: () => rpc.sdkHost.agentDiagnostics(agentId),
    refetchInterval: 3000,
  });
  if (query.error)
    return (
      <p role="alert" className="text-destructive">
        {String(query.error)}
      </p>
    );
  if (!query.data) return <p>Checking session availability…</p>;
  return (
    <div className="space-y-4">
      <p>Sessions run on the agent’s computer and can continue after you close Console.</p>
      {query.data.watchers.length === 0 && (
        <p>Automatic sessions are off. Room messages will not start a session for this agent.</p>
      )}
      {query.data.watchers.map((watcher, index) => (
        <div key={index}>
          <p>
            Automatic sessions:{' '}
            {watcher.running ? 'Available' : watcher.enabled ? 'Unavailable' : 'Off'}
          </p>
          {watcher.enabled && !watcher.running && (
            <p role="alert" className="text-destructive">
              New room messages cannot automatically start this agent.
              {watcher.failure?.includes('watcher delivery gap') &&
                ' Switch lost track of some room messages after a connection interruption.'}{' '}
              Open a session for this agent in Console to continue. Check existing sessions before
              sending an unanswered request again.
            </p>
          )}
          {watcher.failure && (
            <details className="text-muted-foreground text-sm">
              <summary className="cursor-pointer">Technical details</summary>
              <p className="mt-2 break-words">{watcher.failure}</p>
            </details>
          )}
          {watcher.running && watcher.rooms.length > 0 && (
            <p className="text-muted-foreground text-sm">
              Running {watcher.rooms.length} room{' '}
              {watcher.rooms.length === 1 ? 'session' : 'sessions'}.
            </p>
          )}
          {watcher.roomFailures.length > 0 && (
            <div role="alert" className="text-destructive">
              <p>Some rooms could not start a session on this agent.</p>
              <ul className="mt-1 space-y-1 text-sm">
                {watcher.roomFailures.map((failure) => (
                  <li key={failure.sessionId} className="break-words">
                    {failure.roomId}: {failure.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}
      {query.data.sessions.map((session) => (
        <div key={session.sessionId} className="rounded border p-3 text-sm">
          <p>
            {session.provider} · {session.status} · {session.connectivity}
          </p>
          <p className="text-muted-foreground">{session.sessionId}</p>
        </div>
      ))}
      <p className="text-muted-foreground text-sm">
        Open a session to view its messages or stop it. You can turn automatic sessions on or off in
        the agent’s settings.
      </p>
    </div>
  );
}
