import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CircleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { managedAgentState } from '@renderer/features/managed-agents/managed-agent-state';
import {
  MANAGED_AGENTS_KEY,
  refreshEvery,
  useManagedAgents,
} from '@renderer/features/managed-agents/use-managed-agents';
import { useUserChangesLive } from '@renderer/features/managed-agents/use-user-changes';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { PageHeader } from '@renderer/lib/components/page-header';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { Spinner } from '@renderer/lib/ui/spinner';
import { StatusBadge, type StatusTone } from '@renderer/lib/ui/status-badge';
import type { DeviceDetail } from '@shared/core/managed-agents/managed-agents';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';
import { deviceAgents, formatBytes, platformLabel } from './device-model';

type DeviceParams = { serverId: string; machineId: string };

/** How often the device is read again against a server that does not push changes. */
const DEVICE_REFRESH_MS = 15_000;

const STATE: Record<DeviceDetail['state'], { label: string; tone: StatusTone }> = {
  online: { label: 'Online', tone: 'success' },
  offline: { label: 'Offline', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'neutral' },
  revoked: { label: 'Removed', tone: 'danger' },
};

function useDevice(serverId: string, machineId: string) {
  const pushed = useUserChangesLive(serverId);
  return useQuery({
    queryKey: [
      MANAGED_AGENTS_KEY,
      serverId,
      'device',
      machineId,
      workspacesStore.idOnServerInScope(serverId),
    ],
    queryFn: () => rpc.managedAgents.device({ serverId, machineId }),
    refetchInterval: (query) =>
      refreshEvery(DEVICE_REFRESH_MS, pushed, query.state.status === 'error'),
  });
}

function deviceTypeLabel(device: DeviceDetail): string {
  if (device.local?.kind === 'this-computer') return 'This computer';
  if (device.local?.kind === 'ssh-host') return `SSH host · ${device.local.sshHost}`;
  if (device.cloud) return 'Switch cloud';
  return 'Computer';
}

/**
 * One of the owner's devices: whether it is answering, what it runs on, how
 * loaded it is, its providers, and the agents placed on it with how each is
 * doing there, as its controller last reported.
 */
const DeviceMainPanel = observer(function DeviceMainPanel() {
  const { params } = useParams('device');
  const { navigate } = useNavigate();
  const device = useDevice(params.serverId, params.machineId);
  const agents = useManagedAgents(params.serverId);
  const showEdit = useShowModal('editDeviceModal');
  const showRemove = useShowModal('removeDeviceModal');
  const showMove = useShowModal('moveManagedAgentModal');
  const [restartError, setRestartError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const back = (
    <Button
      size="sm"
      variant="ghost"
      className="-ml-2"
      onClick={() => navigate('settings', { tab: 'devices' })}
    >
      <ArrowLeft className="size-4" /> Your devices
    </Button>
  );

  if (device.isPending)
    return (
      <Page>
        <PageHeader title="Device" back={back} />
        <p className="flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner /> Loading the device…
        </p>
      </Page>
    );
  if (device.isError)
    return (
      <Page>
        <PageHeader title="Device" back={back} />
        <p role="alert" className="text-sm text-destructive">
          {failureText(device.error, 'The device could not be read.')}
        </p>
      </Page>
    );

  const detail = device.data;
  const rows = deviceAgents(detail, agents.data ?? []);
  const report = detail.report;
  const state = STATE[detail.state];
  const local = detail.local;
  const restart = async () => {
    setRestarting(true);
    setRestartError(null);
    try {
      if (local?.kind === 'this-computer') await rpc.embeddedController.restart(params.serverId);
      else if (local?.kind === 'ssh-host')
        await rpc.hostControllers.restart({ sshHost: local.sshHost, serverId: params.serverId });
      await device.refetch();
    } catch (cause) {
      setRestartError(failureText(cause, 'The agent controller could not be restarted.'));
    } finally {
      setRestarting(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title={detail.cloud ? 'Switch cloud' : detail.name}
        description={detail.description ?? deviceTypeLabel(detail)}
        back={back}
      >
        <div className="flex items-center gap-2">
          <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
          {local && detail.state !== 'revoked' && (
            <Button
              size="sm"
              variant="outline"
              disabled={restarting}
              onClick={() => void restart()}
            >
              {restarting && <Spinner />}
              Restart controller
            </Button>
          )}
          {!detail.cloud && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => showEdit({ serverId: params.serverId, device: detail })}
            >
              Edit
            </Button>
          )}
          {detail.state !== 'revoked' && !detail.cloud && (
            <Button
              size="sm"
              variant="outline"
              // Until the agents are read, the dialog could not name those left stranded.
              disabled={agents.isPending}
              onClick={() =>
                showRemove({
                  serverId: params.serverId,
                  device: detail,
                  agentNames: agents.isError
                    ? null
                    : rows.map((row) => row.agent.displayName || row.agent.name),
                })
              }
            >
              Remove
            </Button>
          )}
        </div>
      </PageHeader>

      {restartError && (
        <p role="alert" className="text-sm text-destructive">
          {restartError}
        </p>
      )}
      {detail.state === 'revoked' && rows.length > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md bg-background-error px-3 py-2 text-sm text-foreground-error"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            This device was removed, so nothing runs the agents placed on it. Move them to another
            device.
          </span>
        </div>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Details</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-1.5 text-sm">
          <dt className="text-foreground-muted">Type</dt>
          <dd>{deviceTypeLabel(detail)}</dd>
          <dt className="text-foreground-muted">Platform</dt>
          <dd>{platformLabel(report.platform) ?? '—'}</dd>
          <dt className="text-foreground-muted">Agent controller</dt>
          <dd>
            {report.version ?? '—'}
            {report.release && !report.release.current && (
              <span className="text-foreground-muted"> · updating to {report.release.wanted}</span>
            )}
          </dd>
          <dt className="text-foreground-muted">Last seen</dt>
          <dd>{detail.lastSeenAt ? <RelativeTime value={detail.lastSeenAt} /> : 'Never'}</dd>
          {report.machine && (
            <>
              <dt className="text-foreground-muted">Sessions</dt>
              <dd>
                {report.machine.sessionsRunning} running of at most {report.machine.sessionsMax}
              </dd>
              <dt className="text-foreground-muted">Disk</dt>
              <dd>
                {formatBytes(report.machine.diskFreeBytes)} free of{' '}
                {formatBytes(report.machine.diskTotalBytes)}
              </dd>
              <dt className="text-foreground-muted">Memory</dt>
              <dd>
                {formatBytes(report.machine.memFreeBytes)} free of{' '}
                {formatBytes(report.machine.memTotalBytes)}
              </dd>
            </>
          )}
          {detail.workspacesDir && (
            <>
              <dt className="text-foreground-muted">Workspaces</dt>
              <dd className="font-mono text-xs">{detail.workspacesDir}</dd>
            </>
          )}
        </dl>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Providers</h3>
        {detail.providers.length === 0 ? (
          <p className="text-sm text-foreground-muted">Not reported yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {detail.providers.map((provider) => (
              <li key={provider.provider} className="flex items-center gap-2">
                <StatusBadge tone={provider.ready ? 'success' : 'warning'}>
                  {provider.ready ? 'Ready' : (provider.problem ?? 'Not ready')}
                </StatusBadge>
                <span>{providerDisplayName(provider.provider) ?? provider.provider}</span>
                {provider.detail && (
                  <span className="text-xs text-foreground-muted">{provider.detail}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Agents</h3>
        {agents.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {failureText(agents.error, 'Your agents could not be listed.')}
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-foreground-muted">No agents are placed on this device.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-foreground-muted">
                  <th className="px-3 py-2 font-normal">Agent</th>
                  <th className="px-3 py-2 font-normal">State</th>
                  <th className="px-3 py-2 font-normal">Sessions</th>
                  <th className="px-3 py-2 font-normal">Restarts (10 min)</th>
                  <th className="px-3 py-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ agent, report: agentReport }) => {
                  const agentState = managedAgentState(agent);
                  const name = agent.displayName || agent.name;
                  return (
                    <tr key={agent.agentId} className="border-b border-border last:border-b-0">
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="cursor-pointer text-foreground hover:underline"
                          onClick={() =>
                            navigate('managedAgent', {
                              serverId: agent.serverId,
                              agentId: agent.agentId,
                              name: agent.name,
                            })
                          }
                        >
                          {name}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <div>{agentState.label}</div>
                        {agentState.detail && (
                          <div className="text-xs text-foreground-muted">{agentState.detail}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {agentReport ? agentReport.activeSessions : '—'}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {agentReport ? agentReport.restarts10m : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant="ghost" onClick={() => showMove({ agent })}>
                          Move…
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Page>
  );
});

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-auto bg-background">
      <div className="space-y-6 px-8 pb-10">{children}</div>
    </div>
  );
}

export const deviceView = {
  WrapView: ({ children }: { children: React.ReactNode } & DeviceParams) => <>{children}</>,
  MainPanel: DeviceMainPanel,
  canActivate: (params: unknown): GuardResult => {
    // Params can come from a snapshot written by an older build: validate rather than trust.
    const value = (params ?? {}) as Partial<Record<keyof DeviceParams, unknown>>;
    if (
      typeof value.serverId !== 'string' ||
      value.serverId.length === 0 ||
      typeof value.machineId !== 'string' ||
      value.machineId.length === 0
    )
      return { ok: false, redirect: 'settings', params: { tab: 'devices' } };
    return { ok: true };
  },
} satisfies ViewDefinition<DeviceParams>;
