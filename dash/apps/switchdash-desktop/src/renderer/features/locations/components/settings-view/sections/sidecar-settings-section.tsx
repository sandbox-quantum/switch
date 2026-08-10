import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, Power, RefreshCw, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { Field, FieldDescription, FieldTitle } from '@renderer/lib/ui/field';
import { log } from '@renderer/utils/logger';
import type { AgentSidecarStatus, SidecarVerdict } from '@shared/events/sidecarEvents';
import { sidecarStatusChannel } from '@shared/events/sidecarEvents';

/**
 * Per-agent remote sidecar status + lifecycle controls.
 *
 * The sidecar is the on-VM process that keeps a remote agent connected to its
 * Switch rooms while switchdash is closed. It is deployed and upgraded silently
 * on connect; this section makes that state visible — which build the host runs
 * vs. which this client ships — and lets the operator update, restart, or stop it
 * by hand. Rendered only for remote agents (a local agent has no sidecar).
 */

const SHORT_HASH = 7;

const statusQueryKey = (agentId: string): string[] => ['sidecar-status', agentId];

function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, SHORT_HASH) : '—';
}

const VERDICT_DISPLAY: Record<
  SidecarVerdict,
  {
    label: string;
    variant: 'default' | 'secondary' | 'destructive' | 'outline';
    icon: typeof CheckCircle2;
  }
> = {
  'up-to-date': { label: 'Up to date', variant: 'secondary', icon: CheckCircle2 },
  'upgrade-available': { label: 'Update available', variant: 'default', icon: RefreshCw },
  'upgrade-pending': { label: 'Update pending', variant: 'outline', icon: AlertTriangle },
  'newer-on-host': { label: 'Newer on host', variant: 'secondary', icon: CheckCircle2 },
  incompatible: { label: 'Incompatible', variant: 'destructive', icon: AlertTriangle },
  'not-running': { label: 'Not running', variant: 'outline', icon: XCircle },
};

export function SidecarSettingsSection({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const queryKey = statusQueryKey(agentId);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => rpc.sidecar.getStatus(agentId),
  });

  // Live refresh: the controller broadcasts on every probe/upgrade/restart/stop,
  // so seed the cache from the event stream instead of polling.
  useEffect(() => {
    return events.on(sidecarStatusChannel, (status: AgentSidecarStatus) => {
      if (status.agentId === agentId) queryClient.setQueryData(statusQueryKey(agentId), status);
    });
  }, [agentId, queryClient]);

  const actionOptions = {
    onError: (error: unknown) => log.error('sidecar action failed', { agentId, error }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey }),
  };
  const upgrade = useMutation({ mutationFn: () => rpc.sidecar.upgrade(agentId), ...actionOptions });
  const restart = useMutation({ mutationFn: () => rpc.sidecar.restart(agentId), ...actionOptions });
  const stop = useMutation({ mutationFn: () => rpc.sidecar.stop(agentId), ...actionOptions });
  const busy = upgrade.isPending || restart.isPending || stop.isPending;

  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldTitle>Remote sidecar</FieldTitle>
        {data && <VerdictBadge verdict={data.verdict} />}
      </div>
      <FieldDescription className="text-foreground-muted">
        The on-host process that keeps this agent connected to its Switch rooms while Switch Console
        is closed. Updated automatically when Switch Console connects; you can also manage it here.
      </FieldDescription>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-foreground-muted">
          <Loader2 className="size-3.5 animate-spin" /> Checking sidecar…
        </div>
      )}

      {isError && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
          <span className="text-foreground-muted">
            Couldn&apos;t reach the host to check the sidecar.
          </span>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            <RefreshCw className="size-3.5" /> Retry
          </Button>
        </div>
      )}

      {data && (
        <div className="flex flex-col gap-3">
          <VersionRows status={data} />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || data.verdict === 'up-to-date' || data.verdict === 'incompatible'}
              onClick={() => upgrade.mutate()}
            >
              {upgrade.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Update
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => restart.mutate()}>
              {restart.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {data.verdict === 'incompatible' ? 'Replace' : 'Restart'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !data.running}
              onClick={() => stop.mutate()}
            >
              {stop.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Power className="size-3.5" />
              )}
              Stop
            </Button>
          </div>

          {data.verdict === 'upgrade-pending' && (
            <p className="text-xs text-foreground-muted">
              An update is ready but held back because {data.liveSessions} session
              {data.liveSessions === 1 ? '' : 's'} {data.liveSessions === 1 ? 'is' : 'are'} running.
              It applies next time the sidecar is idle — or use Restart to apply it now (running
              sessions reconnect automatically).
            </p>
          )}

          <SidecarLog agentId={agentId} />
        </div>
      )}
    </Field>
  );
}

function VerdictBadge({ verdict }: { verdict: SidecarVerdict }) {
  const { label, variant, icon: Icon } = VERDICT_DISPLAY[verdict];
  return (
    <Badge variant={variant}>
      <Icon className="size-3" /> {label}
    </Badge>
  );
}

function VersionRows({ status }: { status: AgentSidecarStatus }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <Row
        label="This client ships"
        value={`${status.clientVersion}+${shortHash(status.clientHash)}`}
      />
      <Row
        label="Host running"
        value={
          status.running
            ? `${status.deployedVersion ?? '?'}+${shortHash(status.deployedHash)}` +
              (status.epoch !== null ? ` · restart #${status.epoch}` : '') +
              (status.pid !== null ? ` · pid ${status.pid}` : '')
            : 'not running'
        }
      />
      <Row label="Live sessions" value={String(status.liveSessions)} />
      <Row label="Host" value={status.sshHost} />
      <Row label="Working dir" value={status.repoDir} mono />
    </dl>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-foreground-muted">{label}</dt>
      <dd className={mono ? 'truncate font-mono text-xs' : 'truncate'}>{value}</dd>
    </>
  );
}

function SidecarLog({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['sidecar-log', agentId],
    queryFn: () => rpc.sidecar.logTail(agentId),
    enabled: open,
  });

  if (!open) {
    return (
      <Button size="xs" variant="ghost" className="self-start" onClick={() => setOpen(true)}>
        Show recent log
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-foreground-muted">Recent sidecar log</span>
        <Button size="xs" variant="ghost" disabled={isFetching} onClick={() => void refetch()}>
          {isFetching ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          Refresh
        </Button>
      </div>
      <pre className="h-48 max-h-[80vh] min-h-24 resize-y overflow-auto rounded-md border border-border bg-background-2 p-2 text-xs whitespace-pre-wrap">
        {data ? data : 'No log output.'}
      </pre>
    </div>
  );
}
