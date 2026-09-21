import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Loader2, Power, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { DisclosureRow } from '@renderer/lib/ui/disclosure-row';

export function SidecarSettingsSection({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ['shared-host', agentId];
  const [showLogs, setShowLogs] = useState(false);
  const query = useQuery({
    queryKey,
    queryFn: () => rpc.sdkHost.agentDiagnostics(agentId),
    refetchInterval: 5000,
  });
  const logs = useQuery({
    queryKey: ['shared-host-logs', agentId],
    queryFn: () => rpc.sdkHost.agentLogs(agentId),
    enabled: showLogs,
  });
  const action = useMutation({
    mutationFn: (kind: 'update' | 'restart' | 'stop' | 'start') =>
      rpc.sdkHost.manageSidecar(agentId, kind),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: ['agent-auto-session', agentId] }),
        queryClient.invalidateQueries({ queryKey: ['shared-host-logs', agentId] }),
      ]);
    },
  });
  const data = query.data;
  const watcher = data?.watchers[0];
  const running = watcher?.running ?? false;
  const enabled = watcher?.enabled ?? false;
  // A local agent has no sidecar: Console watches its rooms itself, so there is
  // no deployed build to compare and nothing to update, restart or stop here.
  const deployed = data?.transport === 'ssh';
  const differentBuild =
    deployed && !!watcher?.buildHash && watcher.buildHash !== data?.availableBuildHash;
  const status = running
    ? differentBuild
      ? 'Different build'
      : watcher?.buildHash
        ? 'Up to date'
        : 'Running'
    : enabled
      ? 'Unavailable'
      : 'Stopped';

  return (
    <div className="flex flex-col gap-4">
      {data &&
        (deployed ? (
          <p className="text-sm text-foreground-muted">
            The sidecar is a background service on the SSH host that watches this agent’s rooms and
            starts sessions while Console is closed. Manage conversations in Sessions below. Update
            and Restart reload the service. Stop turns off automatic sessions; existing sessions
            continue running.
          </p>
        ) : (
          <p className="text-sm text-foreground-muted">
            Console watches this agent’s rooms itself and starts a session when the agent is
            addressed with none running. It runs inside Console, so quitting Console stops the
            watcher and the sessions it started. Turn it off with Automatic sessions above.
          </p>
        ))}
      {query.isPending && <p className="text-sm">Checking the watcher…</p>}
      {query.error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 text-sm text-destructive"
        >
          <span>Could not check the watcher: {String(query.error)}</span>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {data && (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-md bg-foreground/5 px-3 py-2 text-sm">
            <span className={enabled && !running ? 'text-destructive' : ''}>{status}</span>
            {watcher?.buildHash && (
              <span className="font-mono">{watcher.buildHash.slice(0, 12)}</span>
            )}
            {/* A local watcher reports Console's own PID, which reads as a
                separate process that does not exist. Only a deployed host has
                a PID worth naming. */}
            {deployed && watcher?.pid && (
              <span className="font-mono text-foreground-muted">pid {watcher.pid}</span>
            )}
            <span className="ml-auto text-foreground-muted">
              {deployed ? 'SSH host' : 'Inside Console'}
            </span>
          </div>
          <dl className="divide-y divide-border rounded-md border border-border text-sm">
            {deployed && (
              <>
                <div className="grid grid-cols-[150px_1fr] gap-3 px-4 py-3">
                  <dt className="text-foreground-muted">Running build</dt>
                  <dd className="font-mono break-all">
                    {watcher?.buildHash?.slice(0, 12) ??
                      (running ? 'Not reported by this host' : 'Not running')}
                  </dd>
                </div>
                <div className="grid grid-cols-[150px_1fr] gap-3 px-4 py-3">
                  <dt className="text-foreground-muted">Console build</dt>
                  <dd className="font-mono">{data.availableBuildHash.slice(0, 12)}</dd>
                </div>
              </>
            )}
            <div className="grid grid-cols-[150px_1fr] gap-3 px-4 py-3">
              <dt className="text-foreground-muted">Working dir</dt>
              <dd className="flex min-w-0 items-center gap-2">
                <span className="font-mono break-all">{data.workingDir}</span>
                <CopyDirectory path={data.workingDir} />
              </dd>
            </div>
          </dl>
          {differentBuild && (
            <p className="text-sm text-foreground-muted">
              The watcher is running a different build. Update replaces it with this Console’s
              build.
            </p>
          )}
          {enabled && !running && (
            <p role="alert" className="text-sm text-destructive">
              New room messages cannot automatically start this agent.{' '}
              {deployed
                ? 'Inspect the log before restarting.'
                : 'Inspect the log below; reopening Console starts it again.'}
            </p>
          )}
          {watcher?.failure && (
            <p role="alert" className="text-sm break-words text-destructive">
              {watcher.failure}
            </p>
          )}
          {deployed && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={
                  action.isPending ||
                  !enabled ||
                  (running && !differentBuild && !!watcher?.buildHash)
                }
                onClick={() => action.mutate('update')}
              >
                <RefreshCw className="size-3.5" /> Update
              </Button>
              <Button
                variant="outline"
                disabled={action.isPending}
                onClick={() => action.mutate(enabled ? 'restart' : 'start')}
              >
                <RefreshCw className="size-3.5" /> {enabled ? 'Restart' : 'Start'}
              </Button>
              {action.isPending && (
                <Loader2 aria-label="Managing sidecar" className="size-3.5 animate-spin" />
              )}
              <Button
                variant="outline"
                className="ml-auto text-destructive hover:text-destructive"
                disabled={action.isPending || (!running && !enabled)}
                onClick={() => action.mutate('stop')}
              >
                <Power className="size-3.5" /> Stop
              </Button>
            </div>
          )}
        </>
      )}
      {action.error && (
        <p role="alert" className="text-sm text-destructive">
          {String(action.error)}
        </p>
      )}
      <DisclosureRow
        open={showLogs}
        title="Show recent log"
        onToggle={() => setShowLogs((value) => !value)}
      />
      {showLogs && (
        <div className="space-y-2">
          <Button
            variant="outline"
            size="sm"
            disabled={logs.isFetching}
            onClick={() => void logs.refetch()}
          >
            Refresh log
          </Button>
          {logs.error ? (
            <p role="alert" className="text-sm text-destructive">
              {String(logs.error)}
            </p>
          ) : (
            <pre className="max-h-80 overflow-auto rounded-md border border-border p-3 text-xs break-words whitespace-pre-wrap">
              {logs.isPending ? 'Loading log…' : logs.data || 'No recent log recorded.'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function CopyDirectory({ path }: { path: string }) {
  const copy = useMutation({ mutationFn: () => navigator.clipboard.writeText(path) });
  return (
    <div className="ml-auto shrink-0">
      <Button
        variant="ghost"
        size="sm"
        aria-label="Copy the working directory"
        onClick={() => copy.mutate()}
      >
        <Copy className="size-3.5" />
      </Button>
      {copy.error && (
        <p role="alert" className="text-xs text-destructive">
          Could not copy directory.
        </p>
      )}
    </div>
  );
}
