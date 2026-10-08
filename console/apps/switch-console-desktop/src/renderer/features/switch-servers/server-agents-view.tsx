import { useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  CircleStop,
  ExternalLink,
  MoreVertical,
  Pencil,
  Plug,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { CloudMachineCard } from '@renderer/features/cloud-agents/cloud-machine-card';
import {
  cloudOperationAttempts,
  startAttemptKey,
} from '@renderer/features/cloud-agents/cloud-operation-attempts';
import { CloudStartAttemptStatus } from '@renderer/features/cloud-agents/cloud-start-attempt-status';
import {
  useCloudAgentSessions,
  useCloudAgents,
  useCloudMachines,
} from '@renderer/features/cloud-agents/use-cloud-agents';
import { useConfirmDeleteAgent } from '@renderer/features/locations/hooks/use-confirm-delete-agent';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { getLocationStore } from '@renderer/features/locations/stores/location-selectors';
import {
  managedAgentLabel,
  managedAgentState,
} from '@renderer/features/managed-agents/managed-agent-state';
import {
  useManagedAgents,
  withoutManaged,
} from '@renderer/features/managed-agents/use-managed-agents';
import { refreshSidebarRoomState } from '@renderer/features/sidebar/sidebar-tree-data';
import { AgentConnectionIndicator } from '@renderer/features/switch-rooms/connection-health';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { resetAgentErrorText } from '@renderer/lib/errors/reset-agent-error';
import { toast, useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useAgentIconUrl } from '@renderer/lib/stores/use-workspace-agents';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import type { Agent } from '@shared/core/agents/agents';
import {
  type CloudAgent,
  cloudAgentPhase,
  cloudMachineReady,
} from '@shared/core/cloud-agents/cloud-agents';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';
import { RpcError } from '@shared/lib/ipc/rpc-error';
import { ServerPage } from './server-page';
import { ServerSectionTitlebar } from './server-section-titlebar';
import { switchRoomsStore } from './switch-rooms-store';
import { switchServersStore } from './switch-servers-store';

function useServerId(): string {
  return useParams('serverAgents').params.serverId;
}

const ServerAgentsTitlebar = observer(function ServerAgentsTitlebar() {
  return <ServerSectionTitlebar serverId={useServerId()} icon={Bot} label="Your Agents" />;
});

const ServerAgentsPanel = observer(function ServerAgentsPanel() {
  const serverId = useServerId();
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  const showAddAgentModal = useShowModal('addAgentModal');
  const showConnectionsModal = useShowModal('connectionsModal');

  // The sidebar reads the same two things, but this page must not be right only
  // when the sidebar happened to be open first.
  useEffect(() => {
    void refreshSidebarRoomState(false);
  }, [serverId]);

  const cloud = useCloudAgents(serverId);
  const machines = useCloudMachines(serverId);
  const managed = useManagedAgents(serverId);
  const agents = withoutManaged(agentsStore.agentsOnServer(serverId), managed.data);

  return (
    <ServerPage
      width={880}
      title="Your Agents"
      description={`Agents on ${server?.name ?? 'this server'}. Add one, set how it is addressed, and start sessions.`}
      action={
        cloud.data && (
          <Button variant="outline" size="sm" onClick={() => showConnectionsModal({ serverId })}>
            <Plug className="size-4" />
            Connections
          </Button>
        )
      }
    >
      {machines.data
        ?.filter((machine) => machine.state !== 'deleted')
        .map((machine) => (
          <CloudMachineCard key={machine.machine_id} machine={machine} serverId={serverId} />
        ))}
      {machines.error && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {failureText(machines.error, 'Could not load the cloud machine.')}
        </p>
      )}
      {/* The add tile leads the grid rather than sitting as a button in the
          page header: it is the same kind of thing as the cards after it, and
          on an empty server it is the only thing on screen, which says what to
          do without needing an empty-state sentence.

          Four columns at the design's content width, reflowing narrower rather
          than squashing. The height is a floor rather than a ratio, so a card
          keeps its shape as the column width changes. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-[14px]">
        <button
          type="button"
          onClick={() => showAddAgentModal({ entryPoint: 'server_page' })}
          className="flex min-h-[184px] cursor-pointer items-center justify-center rounded-[11px] border border-dashed border-border text-foreground-muted transition-colors hover:border-border-1 hover:bg-[var(--sel-soft)] hover:text-foreground"
          aria-label="Add agent"
        >
          <Plus className="size-5" />
        </button>
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} serverId={serverId} />
        ))}
        {managed.data?.map((agent) => (
          <ManagedAgentCard key={agent.agentId} agent={agent} />
        ))}
        {cloud.data
          ?.filter((listed) => listed.launch.state !== 'deleted')
          .map((listed) => (
            <CloudAgentCard key={listed.key} listed={listed} serverId={serverId} />
          ))}
      </div>
      {managed.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {failureText(managed.error, 'Could not load managed agents.')}
        </p>
      )}
      {cloud.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {failureText(cloud.error, 'Could not load cloud agents.')}
        </p>
      )}
    </ServerPage>
  );
});

/** What a launch in error means to its owner, by the server's `error_code`. */
const LAUNCH_ERRORS: Record<string, string> = {
  agent_crashed:
    'The agent keeps crashing. Retry it. If it crashes again, contact your server administrator.',
  identity_failed: 'Switch could not register the agent. Retry.',
  worker_needs_attention: 'The cloud worker needs attention. Contact your server administrator.',
  agent_key_missing:
    'Switch lost this agent’s credential, so its machine cannot run it. Remove the agent and create it again.',
  agent_identity_missing: 'Switch lost this agent’s identity. Retry to register it again.',
  worker_attach_timeout:
    'The agent started but did not connect to Switch. Check your provider connection, then retry.',
  agent_stop_timeout: 'The agent did not stop in time. Retry to start it again, or remove it.',
};

function launchErrorText(code: string | null): string {
  const text =
    code !== null && Object.hasOwn(LAUNCH_ERRORS, code) ? LAUNCH_ERRORS[code] : undefined;
  return (
    text ??
    'The cloud worker could not start. Check your provider and GitHub connections, then retry. If it still fails, contact your server administrator.'
  );
}

/** Launch errors a retry cannot clear. */
const NOT_RETRYABLE = new Set(['worker_needs_attention', 'agent_key_missing']);

function lifecycleFailureText(error: unknown): string {
  const code =
    error instanceof RpcError && error.code === 'GatewayError'
      ? error.stringField('code')
      : undefined;
  if (code === 'machine_stopped')
    return 'The owner stopped the cloud machine. Start the machine, then try again.';
  return failureText(error, 'Cloud operation failed.');
}

const CloudAgentCard = observer(function CloudAgentCard({
  listed,
  serverId,
}: {
  listed: CloudAgent;
  serverId: string;
}) {
  const launch = listed.launch;
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => setActionError(null), [launch.revision, launch.state]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const queryClient = useQueryClient();
  const { navigate } = useNavigate();
  const agentKey = listed.key;
  const attempt = cloudOperationAttempts.get(startAttemptKey(agentKey));
  // Asked only while a start is unconfirmed, to tell whether its session exists.
  const withSessions = useCloudAgentSessions(listed, attempt?.status === 'unknown');
  const openSession = (sessionId: string) =>
    navigate('cloudSession', {
      agentKey,
      sessionId,
      name: `${launch.name} · Session ${sessionId.slice(0, 8)}`,
    });
  const newSession = async () => {
    setActionError(null);
    const result = await cloudOperationAttempts.run(
      startAttemptKey(agentKey),
      agentKey,
      'start',
      null
    );
    if (!result) return;
    if (result.outcome.state === 'applied') openSession(result.sessionId);
    else if (result.outcome.state === 'failed') setActionError(result.outcome.message);
    else void queryClient.invalidateQueries({ queryKey: ['cloud-agents'] });
  };
  const run = async (action: 'stop' | 'start' | 'restart' | 'remove' | 'retry') => {
    setPending(true);
    setActionError(null);
    try {
      const result = await rpc.switchServers.cloudLifecycle(
        serverId,
        launch.request_id,
        action,
        launch.revision
      );
      if (result.access_warning)
        toast({ title: 'GitHub access cleanup is pending', description: result.access_warning });
      await queryClient.invalidateQueries({ queryKey: ['cloud-agents'] });
      setConfirmRemove(false);
    } catch (error) {
      setActionError(lifecycleFailureText(error));
      void queryClient.invalidateQueries({ queryKey: ['cloud-agents'] });
    } finally {
      setPending(false);
    }
  };
  const editAgent = useShowModal('editCloudAgentModal');
  const iconUrl = useAgentIconUrl(workspacesStore.idOnServerInScope(serverId), launch.agent_id);
  const phase = launch.desired_state === 'deleted' ? null : cloudAgentPhase(launch, listed.machine);
  const stateLabel =
    phase === 'sleeping'
      ? 'Sleeping'
      : phase === 'machine_stopped'
        ? 'Machine stopped'
        : phase === 'machine_error'
          ? 'Machine error'
          : phase === 'waking'
            ? cloudMachineReady(listed.machine)
              ? 'Starting…'
              : 'Waking…'
            : launch.desired_state === 'stopped'
              ? launch.state === 'stopping'
                ? 'Stopping…'
                : 'Stopped'
              : {
                  queued: 'Queued',
                  provisioning: 'Starting…',
                  ready: 'Ready',
                  error: 'Needs attention',
                  stopping: 'Stopping…',
                  stopped: 'Stopped',
                  deleting: 'Removing…',
                  deleted: 'Removed',
                }[launch.state];
  const usable = launch.agent_id !== null && launch.state === 'ready' && phase === null;
  const machineDown = listed.machine
    ? listed.machine.sleeping || listed.machine.desired_state === 'stopped'
    : launch.sleeping;
  const stoppable =
    !machineDown &&
    launch.desired_state === 'running' &&
    launch.agent_id !== null &&
    ['ready', 'provisioning', 'queued', 'error'].includes(launch.state);
  const crashed = launch.process_state === 'crashed' || launch.error_code === 'agent_crashed';
  return (
    <div className="group relative flex min-h-[184px] flex-col rounded-[11px] bg-[var(--surface-2)] p-[14px]">
      <div className="absolute top-2 right-2 flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-xs" aria-label={`${launch.name} actions`}>
                <MoreVertical className="size-3" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={launch.agent_id === null || launch.desired_state === 'deleted'}
              onClick={() => editAgent({ serverId, launch })}
            >
              <Pencil className="size-4" />
              Edit agent…
            </DropdownMenuItem>
            {stoppable && (
              <DropdownMenuItem disabled={pending} onClick={() => void run('stop')}>
                <CircleStop className="size-4" />
                <span className="flex flex-col">
                  <span>Stop agent</span>
                  <span className="text-xs text-foreground-muted">
                    Stops replies and frees the machine
                  </span>
                </span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-1 items-center justify-center py-3">
        <AgentAvatar name={launch.name} iconUrl={iconUrl} size={66} />
      </div>
      <div className="truncate text-sm font-medium">{launch.name}</div>
      <div className="text-xs text-foreground-muted">
        {providerDisplayName(launch.provider)} · Cloud · {stateLabel}
      </div>
      {(launch.oom_kills > 0 || crashed) && (
        <div className="mt-1 flex flex-wrap gap-1">
          {launch.oom_kills > 0 && (
            <Badge variant="secondary">
              Restarted after running out of memory {launch.oom_kills}×
            </Badge>
          )}
          {crashed && <Badge variant="destructive">Crashed</Badge>}
        </div>
      )}
      {launch.error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {launchErrorText(launch.error_code)}
        </p>
      )}
      {actionError && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {actionError}
        </p>
      )}
      <CloudStartAttemptStatus
        agentKey={agentKey}
        sessions={(withSessions.sessions ?? []).filter((session) => !session.retired)}
        onOpen={openSession}
        onCheckAgain={() => void newSession()}
        className="mt-2 flex-wrap"
      />
      <div className="mt-2 flex flex-wrap gap-1">
        {usable && (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={pending || attempt?.status === 'pending'}
              aria-busy={attempt?.status === 'pending'}
              onClick={() => void newSession()}
            >
              {attempt?.status === 'pending' ? 'Starting session…' : 'New session'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => void run('restart')}
            >
              Restart
            </Button>
          </>
        )}
        {launch.state === 'error' && !NOT_RETRYABLE.has(launch.error_code ?? '') && (
          <Button variant="outline" size="sm" disabled={pending} onClick={() => void run('retry')}>
            Retry
          </Button>
        )}
        {launch.desired_state === 'stopped' && (
          <Button variant="outline" size="sm" disabled={pending} onClick={() => void run('start')}>
            Start agent
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => setConfirmRemove(true)}>
          Remove
        </Button>
      </div>
      {confirmRemove && (
        <div className="mt-2 text-xs">
          <p>
            Remove this agent and its sessions from Switch? Its working copy on the cloud machine is
            deleted right away, with any uncommitted changes. If it is the last agent on your
            machine, the machine shuts down and its disk is kept until the date shown on the machine
            card.
          </p>
          <Button size="sm" disabled={pending} onClick={() => void run('remove')}>
            Remove agent
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
});

/** A managed agent Console has no row for, as its server lists it. */
function ManagedAgentCard({ agent }: { agent: ManagedAgentView }) {
  const { navigate } = useNavigate();
  const label = managedAgentLabel(agent);
  const state = managedAgentState(agent);
  const provider = providerDisplayName(agent.definition.provider) ?? agent.definition.provider;
  return (
    <div className="group relative flex min-h-[184px] flex-col rounded-[11px] bg-[var(--surface-2)] transition-colors hover:bg-[var(--fill)]">
      <button
        type="button"
        aria-label={`Open ${label}`}
        className="focus-visible:ring-ring absolute inset-0 cursor-pointer rounded-[11px] focus-visible:ring-2 focus-visible:outline-none"
        onClick={() =>
          navigate('managedAgent', {
            serverId: agent.serverId,
            agentId: agent.agentId,
            name: label,
          })
        }
      />
      <div className="pointer-events-none flex flex-1 flex-col p-[14px]">
        <div className="flex flex-1 items-center justify-center py-3">
          <AgentAvatar name={label} iconUrl={agent.iconUrl} size={66} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{label}</div>
          <div className="truncate text-xs text-foreground-muted">
            {provider} · {agent.machine?.name ?? 'no machine'}
          </div>
        </div>
      </div>
      <div
        className={`pointer-events-none px-3.5 pb-3 text-xs ${state.tone === 'problem' ? 'text-destructive' : 'text-foreground-muted'}`}
      >
        {state.label}
      </div>
    </div>
  );
}

const AgentCard = observer(function AgentCard({
  agent,
  serverId,
}: {
  agent: Agent;
  serverId: string;
}) {
  const { navigate } = useNavigate();
  const showConfirmReset = useShowModal('resetAgentModal');
  const confirmDeleteAgent = useConfirmDeleteAgent();
  const { toastPromise } = useToast();

  const location = getLocationStore(agent.locationId);
  const sshHost = location?.data?.sshHost ?? null;
  const label = agent.name || 'Unnamed agent';
  const provider = providerDisplayName(agent.providerId);
  const iconUrl = useAgentIconUrl(agent.workspaceId, agent.switchAgentId);

  const gatewayUrl =
    agent.switchAgentId && switchRoomsStore.gatewayAgentUrl(serverId, agent.switchAgentId);

  return (
    <div className="group relative flex min-h-[184px] flex-col rounded-[11px] bg-[var(--surface-2)] transition-colors hover:bg-[var(--fill)]">
      {/* One real button covering the card, so the whole tile is the target and
          screen readers get a single named control rather than a grid of
          nested ones. The visible content below it is inert; the actions after
          it sit on top and keep their own clicks. */}
      <button
        type="button"
        aria-label={`Open ${label}`}
        className="focus-visible:ring-ring absolute inset-0 cursor-pointer rounded-[11px] focus-visible:ring-2 focus-visible:outline-none"
        onClick={() => navigate('location', { locationId: agent.locationId, agentName: label })}
      />

      <div className="pointer-events-none flex flex-1 flex-col p-[14px]">
        <div className="flex flex-1 items-center justify-center py-3">
          <AgentAvatar name={label} iconUrl={iconUrl} size={66} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{label}</div>
          <div className="truncate text-xs text-foreground-muted">
            {provider ? `${provider} · ` : ''}
            {sshHost ?? 'this computer'}
          </div>
          {agent.ownerName && (
            <div className="truncate text-xs text-foreground-tertiary-passive">
              loaded · by {agent.ownerName}
            </div>
          )}
        </div>
      </div>

      <div className="relative self-start px-3.5 pb-3">
        <AgentConnectionIndicator agent={agent} showLabel />
      </div>

      {/* Open in gateway, Reset and Remove, on hover. Kept rather than dropped
          with the table: none of them has another entry point from this page.
          Starting a session is not here — the sidebar is where sessions begin. */}
      <div className="absolute top-2 right-2 flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-xs" aria-label={`${label} actions`}>
                <MoreVertical className="size-3" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            {gatewayUrl && (
              <DropdownMenuItem
                onClick={() =>
                  void rpc.switchServers.openGatewayPage({ serverId, url: gatewayUrl })
                }
              >
                <ExternalLink className="size-4" />
                Open in gateway
              </DropdownMenuItem>
            )}
            {sshHost != null && (
              <DropdownMenuItem
                onClick={() =>
                  showConfirmReset({
                    agentLabel: label,
                    onSuccess: () => {
                      void toastPromise(rpc.agents.resetRemoteAgent({ agentId: agent.id }), {
                        loading: `Resetting ${label}…`,
                        success: `${label} was reset`,
                        error: (error) => {
                          return resetAgentErrorText(error);
                        },
                      });
                    },
                  })
                }
              >
                <RotateCcw className="size-4" />
                Reset agent…
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                void confirmDeleteAgent({
                  locationId: agent.locationId,
                  agentId: agent.id,
                  locationLabel: label,
                  onDeleted: () => {},
                });
              }}
            >
              <Trash2 className="size-4" />
              Remove agent…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
});

export const serverAgentsView = {
  WrapView: ({ children }: { children: React.ReactNode; serverId: string }) => <>{children}</>,
  TitlebarSlot: ServerAgentsTitlebar,
  MainPanel: ServerAgentsPanel,
  canActivate: (params: unknown): GuardResult => {
    const serverId =
      typeof params === 'object' && params !== null
        ? (params as { serverId?: unknown }).serverId
        : undefined;
    if (typeof serverId !== 'string') return { ok: false, redirect: 'home' };
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string }>;
