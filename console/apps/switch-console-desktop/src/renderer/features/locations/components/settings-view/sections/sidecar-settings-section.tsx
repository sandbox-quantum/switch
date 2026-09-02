import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Loader2,
  Power,
  RefreshCw,
  Server,
  Users,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { DisclosureRow, disclosureRowClass } from '@renderer/lib/ui/disclosure-row';
import { Field, FieldDescription } from '@renderer/lib/ui/field';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';
import type { AgentSidecarStatus, SidecarVerdict } from '@shared/events/sidecarEvents';
import { sidecarStatusChannel } from '@shared/events/sidecarEvents';

/**
 * Per-agent remote sidecar status + lifecycle controls.
 *
 * The sidecar is the on-VM process that keeps a remote agent connected to its
 * Switch rooms while Switch Console is closed. It is deployed and upgraded silently
 * on connect; this section makes that state visible — which build the host runs
 * vs. which this client ships — and lets the operator update, restart, or stop it
 * by hand. Rendered only for remote agents (a local agent has no sidecar).
 */

const SHORT_HASH = 7;

const statusQueryKey = (agentId: string): string[] => ['sidecar-status', agentId];

function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, SHORT_HASH) : '—';
}

/**
 * Who deployed the sidecar that is running, in the operator's terms.
 *
 * The id itself is meaningless on its own, so it is shown only for the case
 * where two of them are being told apart — and then abbreviated, as a handle to
 * match against the other machine's, not as something to read.
 */
function deployedByLabel(status: AgentSidecarStatus): string {
  if (!status.deployedBy) return 'unknown (deployed before installs were identified)';
  if (status.deployedBy === status.clientDeployerId) return 'this install';
  return `another install (${shortHash(status.deployedBy)})`;
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
  'other-install': { label: "Another install's build", variant: 'secondary', icon: Users },
  incompatible: { label: 'Incompatible', variant: 'destructive', icon: AlertTriangle },
  'not-running': { label: 'Not running', variant: 'outline', icon: XCircle },
};

/**
 * Verdicts where Update has nothing to do, so the button is disabled rather than
 * offering an action the deploy policy will decline. `other-install` is one of
 * them: this build is not an upgrade over another install's build of the same
 * release, and offering it to both installs is the tug-of-war itself. Restart
 * remains the deliberate way to take the sidecar over.
 */
const NOTHING_TO_UPDATE = new Set<SidecarVerdict>(['up-to-date', 'incompatible', 'other-install']);

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
      {data && <StatusStrip status={data} />}

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
        <div className="flex flex-col gap-4">
          <VersionRows status={data} />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={busy || NOTHING_TO_UPDATE.has(data.verdict)}
              onClick={() => upgrade.mutate()}
            >
              {upgrade.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Update
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => restart.mutate()}>
              {restart.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {data.verdict === 'incompatible' ? 'Replace' : 'Restart'}
            </Button>

            <p className="min-w-0 flex-1 px-2 text-xs text-foreground-muted">
              {data.verdict === 'other-install' &&
                'Another Switch Console install on this host deployed the running sidecar, from the same release as yours. Neither build is newer, so this one leaves it alone rather than the two of you replacing it in turn. Use Restart to run your build instead — the other install will then leave yours alone.'}
              {data.verdict === 'upgrade-pending' &&
                `An update is ready but held back because ${data.liveSessions} session${
                  data.liveSessions === 1 ? ' is' : 's are'
                } running. It applies next time the sidecar is idle — or use Restart to apply it now (running sessions reconnect automatically).`}
            </p>

            <Button
              variant="outline"
              className="ml-auto text-destructive hover:text-destructive"
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

          <SidecarLog agentId={agentId} />
        </div>
      )}
    </Field>
  );
}

/**
 * What the host is running right now, in one line: the verdict, the build with
 * its restart count and pid, and which host it is. The first thing to look at,
 * so it is the first thing on the section.
 */
function StatusStrip({ status }: { status: AgentSidecarStatus }) {
  return (
    <div className="flex items-center gap-3 rounded-[10px] bg-[var(--surface-2)] px-3 py-2.5">
      <VerdictBadge verdict={status.verdict} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">
        {status.running ? runningBuildLine(status) : 'not running'}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-foreground-muted">
        <Server className="size-3.5" />
        {status.sshHost}
      </span>
    </div>
  );
}

function runningBuildLine(status: AgentSidecarStatus): string {
  return (
    `${status.deployedVersion ?? '?'}+${shortHash(status.deployedHash)}` +
    (status.epoch !== null ? ` · restart #${status.epoch}` : '') +
    (status.pid !== null ? ` · pid ${status.pid}` : '')
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
  const clientBuild = `${status.clientVersion}+${shortHash(status.clientHash)}`;
  const hostBuild = status.running
    ? `${status.deployedVersion ?? '?'}+${shortHash(status.deployedHash)}`
    : null;

  return (
    <dl className="divide-y divide-border overflow-hidden rounded-[10px] border border-border text-sm">
      <Row label="Version">
        {/* Both builds on one line, in the direction the update would go. Read
          as two rows they were two facts to compare; read as one they are the
          gap itself. */}
        <span className="flex flex-wrap items-center gap-2 font-mono text-xs">
          {hostBuild === null ? (
            <span className="text-foreground-muted">not running</span>
          ) : (
            <>
              <span>{hostBuild}</span>
              {hostBuild !== clientBuild && (
                <>
                  <ArrowRight className="size-3.5 text-foreground-muted" />
                  <span>{clientBuild}</span>
                </>
              )}
            </>
          )}
          {hostBuild !== clientBuild && (
            <span className="font-sans text-foreground-muted">this client ships</span>
          )}
        </span>
      </Row>
      <Row label="Live sessions">{String(status.liveSessions)}</Row>
      {status.running && <Row label="Deployed by">{deployedByLabel(status)}</Row>}
      <Row label="Working dir">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-xs">{status.repoDir}</span>
          <CopyButton value={status.repoDir} label="Copy the working directory" />
        </span>
      </Row>
    </dl>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-3 py-2.5">
      <dt className="w-32 shrink-0 text-foreground-muted">{label}</dt>
      <dd className="min-w-0 flex-1 truncate">{children}</dd>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      className="ml-auto shrink-0"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          (error: unknown) => log.error('Failed to copy to the clipboard', { error })
        );
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
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
    return <DisclosureRow open={false} title="Show recent log" onToggle={() => setOpen(true)} />;
  }

  return (
    <div className="flex flex-col gap-1">
      <div className={cn(disclosureRowClass, 'justify-between hover:bg-transparent')}>
        <button
          type="button"
          aria-expanded
          className="-mx-2 flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors hover:bg-background-1"
          onClick={() => setOpen(false)}
        >
          <ChevronRight className="size-4 rotate-90 text-foreground-muted" />
          <span className="font-medium text-foreground">Recent sidecar log</span>
        </button>
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
