import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Circle,
  Loader2,
  Plug,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';
import { sshConnectionEventChannel } from '@shared/core/ssh/sshEvents';
import { updateCheckUnavailable } from '@shared/core/switch-setup/update-check';
import { GhAuthPanel } from './gh-auth-panel';
import { hostSetupQueryKey } from './query-keys';

type RemoteDep = Awaited<ReturnType<typeof rpc.remoteHosts.probeDeps>>[number];
type AgentPluginStatus = Awaited<ReturnType<typeof rpc.remoteHosts.listAgentTypePlugins>>[number];
type InstallResult = Awaited<ReturnType<typeof rpc.remoteHosts.installDep>>;

/** Human-readable message from a failed installDep Result (surface, don't swallow). */
function describeInstallError(result: Extract<InstallResult, { success: false }>): string {
  const e = result.error as { type?: string; message?: string; output?: string };
  return e.message || e.output || e.type || 'Install failed.';
}

function depsQueryKey(sshHost: string) {
  return ['remote-host-deps', sshHost];
}
function pluginsQueryKey(sshHost: string) {
  return ['remote-host-plugins', sshHost];
}
function connectionQueryKey(sshHost: string) {
  return ['remote-host-connection', sshHost];
}

type HostConnectionStatus = Awaited<ReturnType<typeof rpc.remoteHosts.getConnectionStatus>>;

/** Compact live badge for the host's pooled SSH connection. */
function ConnectionBadge({ status }: { status: HostConnectionStatus | undefined }) {
  if (!status) return null;
  if (status.state === 'connected' && status.health.status === 'degraded') {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-500">
        <AlertTriangle className="size-3.5" /> Connection degraded
      </span>
    );
  }
  switch (status.state) {
    case 'connected':
      return (
        <span className="flex items-center gap-1 text-xs text-green-500">
          <CheckCircle2 className="size-3.5" /> Connected
        </span>
      );
    case 'connecting':
    case 'reconnecting':
      return (
        <span className="flex items-center gap-1 text-xs text-foreground-muted">
          <Loader2 className="size-3.5 animate-spin" />
          {status.state === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        </span>
      );
    case 'error':
      return (
        <span className="text-destructive flex items-center gap-1 text-xs">
          <XCircle className="size-3.5" /> Connection failed
        </span>
      );
    case 'disconnected':
      return (
        <span className="flex items-center gap-1 text-xs text-foreground-muted">
          <Circle className="size-3.5" /> Not connected
        </span>
      );
  }
}

/**
 * Whether a row is fully usable, not just "the binary exists". `partial` means a
 * required follow-up step is outstanding (gh installed but not authenticated; agent
 * CLI installed but the Switch plugin isn't) — green is reserved for `ready`.
 */
type Readiness = 'ready' | 'partial' | 'missing' | 'error';

function StatusIcon({ readiness }: { readiness: Readiness }) {
  if (readiness === 'ready') return <CheckCircle2 className="size-4 text-green-500" />;
  if (readiness === 'partial') return <AlertTriangle className="size-4 text-amber-500" />;
  if (readiness === 'error') return <AlertTriangle className="size-4 text-amber-500" />;
  return <XCircle className="size-4 text-foreground-muted" />;
}

type StepState = 'done' | 'current' | 'pending' | 'busy';

type Step = { label: string; state: StepState };

/**
 * Compact horizontal progress for a multi-step row (e.g. gh: Installed →
 * Authenticated; agent type: CLI → Plugin). Done steps are green, the next
 * actionable step is amber, later steps are muted, and an in-flight step spins.
 */
function StepList({ steps }: { steps: Step[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6">
      {steps.map((step, i) => (
        <div key={step.label} className="flex items-center gap-2">
          {i > 0 && <ChevronRight className="size-3 text-foreground-muted" />}
          <span
            className={cn(
              'inline-flex items-center gap-1 text-xs',
              step.state === 'pending' ? 'text-foreground-muted' : 'text-foreground'
            )}
          >
            {step.state === 'done' ? (
              <CheckCircle2 className="size-3.5 text-green-500" />
            ) : step.state === 'busy' ? (
              <Loader2 className="size-3.5 animate-spin text-amber-500" />
            ) : step.state === 'current' ? (
              <Circle className="size-3.5 fill-amber-500 text-amber-500" />
            ) : (
              <Circle className="size-3.5 text-foreground-muted" />
            )}
            {step.label}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Detail for one onboarded remote host, gated on the SSH connection: opening it
 * first establishes (or rebuilds) the pooled connection, and only once
 * connected shows the dependency + plugin sections, whose Refresh re-probes
 * them. Probing over a connection that is known to be down would only mislabel
 * every dependency as missing, so the disconnected view offers Connect instead.
 */
export function RemoteHostDetail({ sshHost }: { sshHost: string }) {
  const queryClient = useQueryClient();
  const [authenticatingGh, setAuthenticatingGh] = useState(false);

  const connection = useQuery({
    queryKey: connectionQueryKey(sshHost),
    queryFn: () => rpc.remoteHosts.getConnectionStatus(sshHost),
  });
  const isConnected = connection.data?.state === 'connected';

  // Probing is an SSH round-trip, so cache it: re-expanding a host reuses the
  // last result instead of re-probing. Refresh and post-install invalidation
  // force a re-fetch when the data actually needs to change. Enabled only
  // while connected — the connect step below runs first.
  const deps = useQuery({
    queryKey: depsQueryKey(sshHost),
    queryFn: () => rpc.remoteHosts.probeDeps(sshHost),
    staleTime: Infinity,
    gcTime: Infinity,
    enabled: isConnected,
  });
  const plugins = useQuery({
    queryKey: pluginsQueryKey(sshHost),
    queryFn: () => rpc.remoteHosts.listAgentTypePlugins(sshHost),
    staleTime: Infinity,
    gcTime: Infinity,
    enabled: isConnected,
  });

  // Live-update the badge: the main process broadcasts every connection
  // transition (connected/reconnecting/health-changed/…), so refetch on any
  // event for this host's pooled connection (id shape: `agent-ssh:<host>`).
  useEffect(() => {
    return events.on(sshConnectionEventChannel, (event) => {
      if (!event.connectionId.endsWith(`:${sshHost}`)) return;
      void queryClient.invalidateQueries({ queryKey: connectionQueryKey(sshHost) });
    });
  }, [sshHost, queryClient]);

  const connect = useMutation({
    mutationFn: () => rpc.remoteHosts.reconnectHost(sshHost),
    onError: (error) => log.error('Remote host connect failed', { sshHost, error }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: connectionQueryKey(sshHost) });
      void queryClient.invalidateQueries({ queryKey: hostSetupQueryKey(sshHost) });
    },
  });

  // Connect-on-open: the page's first step is establishing the connection.
  // One automatic attempt per mount; after a failure the user retries via the
  // Connect button.
  const { mutate: startConnect, isPending: connectPending, isError: connectFailed } = connect;
  const autoConnectAttempted = useRef(false);
  const connectionState = connection.data?.state;
  useEffect(() => {
    if (connectionState === undefined || autoConnectAttempted.current) return;
    if (connectionState === 'connected' || connectionState === 'connecting') return;
    if (connectionState === 'reconnecting') return; // the manager is already on it
    autoConnectAttempted.current = true;
    startConnect();
  }, [connectionState, startConnect]);

  const coreDeps = (deps.data ?? []).filter((d) => d.category === 'core');
  // Only agent types that support the Switch connector plugin can be set up to
  // run in Switch, so those are the only ones offered here.
  const supportedAgentIds = new Set(
    (plugins.data ?? []).filter((p) => p.supported).map((p) => p.agentId)
  );
  const agentDeps = (deps.data ?? []).filter(
    (d) => d.category === 'agent' && supportedAgentIds.has(d.id)
  );

  const refreshing = deps.isFetching || plugins.isFetching;
  const establishing =
    connectPending ||
    connection.isLoading ||
    connectionState === 'connecting' ||
    connectionState === 'reconnecting';

  // Step 1: not connected yet — show the connection state and a Connect
  // action; the deps sections only exist once the connection is up.
  if (!isConnected) {
    return (
      <div className="flex flex-col gap-3 border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2">
            {establishing ? (
              <span className="flex items-center gap-1 text-xs text-foreground-muted">
                <Loader2 className="size-3.5 animate-spin" /> Connecting…
              </span>
            ) : (
              <ConnectionBadge status={connection.data} />
            )}
            {connectFailed && !connectPending && (
              <span className="text-destructive truncate text-xs">
                {(connect.error as Error).message}
              </span>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={establishing}
            onClick={() => connect.mutate()}
          >
            <Plug className="size-3.5" /> {establishing ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      </div>
    );
  }

  // Step 2: connected — the deps page, refreshable.
  return (
    <div className="flex flex-col gap-5 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <ConnectionBadge status={connection.data} />
        <Button
          size="sm"
          variant="outline"
          disabled={refreshing}
          onClick={() => {
            void deps.refetch();
            void plugins.refetch();
          }}
        >
          <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      <section className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">Dependencies</h4>
        {deps.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-foreground-muted">
            <Spinner /> Checking host…
          </div>
        ) : deps.isError ? (
          <p className="text-destructive text-xs">
            Could not reach host: {(deps.error as Error).message}
          </p>
        ) : coreDeps.length === 0 ? (
          <p className="text-xs text-foreground-muted">No tool dependencies to report.</p>
        ) : (
          coreDeps.map((dep) => (
            <DepRow
              key={dep.id}
              sshHost={sshHost}
              dep={dep}
              onAuthenticate={() => setAuthenticatingGh(true)}
            />
          ))
        )}
        {authenticatingGh && (
          <GhAuthPanel
            sshHost={sshHost}
            onDone={() => {
              setAuthenticatingGh(false);
              void queryClient.invalidateQueries({ queryKey: depsQueryKey(sshHost) });
            }}
          />
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">Agent types & Switch plugin</h4>
        {deps.isLoading || plugins.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-foreground-muted">
            <Spinner /> Checking agent types…
          </div>
        ) : agentDeps.length === 0 ? (
          <p className="text-xs text-foreground-muted">No agent types to report.</p>
        ) : (
          agentDeps.map((dep) => (
            <AgentTypeRow
              key={dep.id}
              sshHost={sshHost}
              dep={dep}
              plugin={(plugins.data ?? []).find((p) => p.agentId === dep.id)}
            />
          ))
        )}
      </section>
    </div>
  );
}

function DepRow({
  sshHost,
  dep,
  onAuthenticate,
}: {
  sshHost: string;
  dep: RemoteDep;
  onAuthenticate: () => void;
}) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: depsQueryKey(sshHost) });
    void queryClient.invalidateQueries({ queryKey: hostSetupQueryKey(sshHost) });
  };

  // gh is a two-step row (install → authenticate); other core deps are single-step.
  const isGh = dep.ghAuth !== undefined;

  const install = useMutation({
    mutationFn: () => rpc.remoteHosts.installDep({ sshHost, id: dep.id }),
    onSuccess: (result) => {
      // Auto-advance: once gh is installed it still needs auth, so go straight
      // to the auth step instead of making the user click a second time.
      if (result.success && isGh) onAuthenticate();
    },
    onError: (error) => log.error('Remote dep install failed', { sshHost, id: dep.id, error }),
    onSettled: invalidate,
  });

  const installed = dep.status === 'available';
  // gh reports auth separately: installed but not authenticated is still unusable.
  const needsGhAuth = isGh && !dep.ghAuth!.authenticated;
  const authed = isGh && dep.ghAuth!.authenticated;

  const readiness: Readiness =
    dep.status === 'error' ? 'error' : !installed ? 'missing' : needsGhAuth ? 'partial' : 'ready';

  const steps: Step[] = isGh
    ? [
        {
          label: 'Installed',
          state: installed ? 'done' : install.isPending ? 'busy' : 'current',
        },
        {
          label: authed ? `Authenticated as ${dep.ghAuth!.account ?? 'you'}` : 'Authenticate',
          state: !installed ? 'pending' : authed ? 'done' : 'current',
        },
      ]
    : [];

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <StatusIcon readiness={readiness} />
          <span className="text-sm">{dep.name}</span>
          {dep.version && <span className="text-xs text-foreground-muted">{dep.version}</span>}
        </div>
        {dep.status === 'error' && dep.error && (
          <span className="text-xs text-amber-500">{dep.error}</span>
        )}
        {isGh && <StepList steps={steps} />}
      </div>
      <div className="flex items-center gap-2">
        {install.isError && <span className="text-destructive text-xs">Install failed</span>}
        {!installed && dep.canInstall && (
          <Button size="sm" disabled={install.isPending} onClick={() => install.mutate()}>
            {install.isPending ? 'Installing…' : 'Install'}
          </Button>
        )}
        {installed && needsGhAuth && (
          <Button size="sm" onClick={onAuthenticate}>
            Authenticate
          </Button>
        )}
      </div>
    </div>
  );
}

function AgentTypeRow({
  sshHost,
  dep,
  plugin,
}: {
  sshHost: string;
  dep: RemoteDep;
  plugin: AgentPluginStatus | undefined;
}) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: depsQueryKey(sshHost) });
    void queryClient.invalidateQueries({ queryKey: pluginsQueryKey(sshHost) });
    void queryClient.invalidateQueries({ queryKey: hostSetupQueryKey(sshHost) });
  };

  const installPlugin = useMutation({
    mutationFn: () => rpc.remoteHosts.installAgentPlugin({ sshHost, agentId: dep.id }),
    onSuccess: (result) =>
      setActionError(result.success ? null : (result.message ?? 'Plugin install failed.')),
    onError: (error) => {
      log.error('Remote plugin install failed', { sshHost, id: dep.id, error });
      setActionError(error instanceof Error ? error.message : 'Plugin install failed.');
    },
    onSettled: invalidateAll,
  });

  const installCli = useMutation({
    mutationFn: () => rpc.remoteHosts.installDep({ sshHost, id: dep.id }),
    onSuccess: (result) => {
      if (!result.success) {
        setActionError(describeInstallError(result));
        return;
      }
      setActionError(null);
      // Auto-advance: the CLI alone can't participate in Switch — once it's in,
      // install the Switch plugin without a second click.
      if (plugin?.supported && !plugin.installed) installPlugin.mutate();
    },
    onError: (error) => {
      log.error('Remote agent CLI install failed', { sshHost, id: dep.id, error });
      setActionError(error instanceof Error ? error.message : 'CLI install failed.');
    },
    onSettled: invalidateAll,
  });

  const updatePlugin = useMutation({
    mutationFn: () => rpc.remoteHosts.updateAgentPlugin({ sshHost, agentId: dep.id }),
    onSuccess: (result) =>
      setActionError(result.success ? null : (result.message ?? 'Plugin update failed.')),
    onError: (error) => {
      log.error('Remote plugin update failed', { sshHost, id: dep.id, error });
      setActionError(error instanceof Error ? error.message : 'Plugin update failed.');
    },
    onSettled: invalidateAll,
  });

  const checkUpdates = useMutation({
    mutationFn: () => rpc.remoteHosts.checkAgentPluginUpdates({ sshHost, agentId: dep.id }),
    onSuccess: (status) => {
      setActionError(
        status.refreshError
          ? `Could not refresh the plugin marketplace — showing cached status. ${status.refreshError}`
          : null
      );
      queryClient.setQueryData(pluginsQueryKey(sshHost), (prev: AgentPluginStatus[] | undefined) =>
        prev?.map((p) => (p.agentId === status.agentId ? status : p))
      );
    },
    onError: (error) => {
      log.error('Remote plugin update check failed', { sshHost, id: dep.id, error });
      setActionError(error instanceof Error ? error.message : 'Update check failed.');
    },
  });

  const cliInstalled = dep.status === 'available';
  const pending =
    installCli.isPending ||
    installPlugin.isPending ||
    updatePlugin.isPending ||
    checkUpdates.isPending;

  // Green only when the agent type is fully usable: CLI present AND (the Switch
  // plugin is installed, or this agent type has no plugin). CLI-without-plugin is
  // a partial (amber) state.
  const pluginNeeded = plugin?.supported === true && !plugin.installed;
  const readiness: Readiness =
    dep.status === 'error'
      ? 'error'
      : !cliInstalled
        ? 'missing'
        : pluginNeeded
          ? 'partial'
          : 'ready';

  // Not "no update available": this agent type advertises no versions on a
  // remote host, so `updateAvailable` is structurally always false and saying
  // nothing would read as "current".
  const currencyUnknown = plugin !== undefined && updateCheckUnavailable(plugin);

  const pluginStepLabel =
    plugin?.installed && plugin.updateAvailable
      ? 'Plugin · update available'
      : plugin?.installed && currencyUnknown
        ? `Plugin ${plugin.installedVersion ?? ''} · updates not detectable`.trim()
        : plugin?.installed
          ? `Plugin ${plugin.installedVersion ?? ''}`.trim()
          : 'Switch plugin';

  const steps: Step[] = [
    {
      label: cliInstalled ? `CLI ${dep.version ?? ''}`.trim() : 'Install CLI',
      state: cliInstalled ? 'done' : installCli.isPending ? 'busy' : 'current',
    },
    {
      label: pluginStepLabel,
      state: !cliInstalled
        ? 'pending'
        : plugin?.installed
          ? 'done'
          : installPlugin.isPending
            ? 'busy'
            : 'current',
    },
  ];

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <StatusIcon readiness={readiness} />
          <span className="text-sm">{dep.name}</span>
        </div>
        <StepList steps={steps} />
        {actionError && <span className="text-destructive pl-6 text-xs">{actionError}</span>}
      </div>
      <div className="flex items-center gap-2">
        {!cliInstalled && dep.canInstall && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => installCli.mutate()}
          >
            {installCli.isPending ? 'Installing…' : 'Install CLI'}
          </Button>
        )}
        {cliInstalled && plugin?.supported && !plugin.installed && (
          <Button size="sm" disabled={pending} onClick={() => installPlugin.mutate()}>
            {installPlugin.isPending ? 'Installing…' : 'Install plugin'}
          </Button>
        )}
        {cliInstalled && plugin?.installed && !plugin.updateAvailable && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => checkUpdates.mutate()}
          >
            {checkUpdates.isPending ? 'Checking…' : 'Check for updates'}
          </Button>
        )}
        {cliInstalled && plugin?.installed && (plugin.updateAvailable || currencyUnknown) && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => updatePlugin.mutate()}
          >
            {updatePlugin.isPending
              ? 'Updating…'
              : plugin.updateAvailable
                ? 'Update plugin'
                : 'Reinstall plugin'}
          </Button>
        )}
      </div>
    </div>
  );
}
