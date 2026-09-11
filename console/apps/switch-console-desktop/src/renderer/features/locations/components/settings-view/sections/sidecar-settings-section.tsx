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
  if (!query.data) return <p>Checking SDK hosts…</p>;
  return (
    <div className="space-y-4">
      <p>SDK sessions run on the execution host and continue when Console closes.</p>
      {query.data.watchers.length === 0 && (
        <p>Automatic room startup is not enabled on this host.</p>
      )}
      {query.data.watchers.map((watcher, index) => (
        <div key={index}>
          <p>
            Room watcher:{' '}
            {watcher.running ? 'Running' : watcher.enabled ? 'Unavailable' : 'Disabled'}
          </p>
          {watcher.failure && (
            <p role="alert" className="text-destructive">
              {watcher.failure}
            </p>
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
        Use the session transcript to interrupt or stop execution. Enable automatic sessions in the
        agent’s settings.
      </p>
    </div>
  );
}
