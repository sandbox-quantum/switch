import { format } from 'date-fns';
import { ExternalLink, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { CopyButton } from '@renderer/features/admin/copy-button';
import { CloudMachineCard } from '@renderer/features/cloud-agents/cloud-machine-card';
import { useCloudMachines } from '@renderer/features/cloud-agents/use-cloud-agents';
import {
  managedAgentLabel,
  managedAgentState,
} from '@renderer/features/managed-agents/managed-agent-state';
import type { ManagedTone } from '@renderer/features/switch-servers/managed-server-state';
import { MessageBox } from '@renderer/features/switch-servers/server-page-ui';
import { agoLabel } from '@renderer/features/switch-servers/server-times';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Progress } from '@renderer/lib/ui/progress';
import { formatBytes } from '@renderer/utils/formatBytes';
import { cn } from '@renderer/utils/utils';
import type { MachineDetail, ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';
import { Card } from './detail-card';
import { MachineIcon, TONE_DOT, TonePill } from './machine-marks';
import { MachineProviders } from './machine-providers';
import {
  controllerRelease,
  lastContact,
  machineConnection,
  machineKindLabel,
  machineNotices,
  type MachineTone,
  platformLabel,
} from './machine-state';
import { useDeviceActions } from './use-device-actions';

/** A notice's box, in the server page's hues. */
const NOTICE_TONE: Record<MachineTone, ManagedTone> = {
  ok: 'running',
  warning: 'attention',
  problem: 'failed',
  idle: 'stopped',
};

const STATE_TEXT: Record<MachineTone, string> = {
  ok: 'text-foreground',
  warning: 'text-foreground-warning',
  problem: 'text-foreground-error',
  idle: 'text-[var(--fg-dim)]',
};

const AGENT_TONE: Record<ReturnType<typeof managedAgentState>['tone'], MachineTone> = {
  ok: 'ok',
  busy: 'warning',
  idle: 'idle',
  problem: 'problem',
};

const PROCESS_TONE: Record<string, MachineTone> = {
  running: 'ok',
  starting: 'warning',
  pending: 'warning',
  restarting: 'warning',
  crashed: 'problem',
  failed: 'problem',
};

/**
 * One device's page: what it is and whether it is connected, anything that
 * needs doing about it, then its details, connection, system and software,
 * the agents on it and its AI providers, each in a card.
 */
export function MachineDetails({
  serverId,
  machine,
  placed,
}: {
  serverId: string;
  machine: MachineDetail;
  /** The managed agents placed on it. */
  placed: ManagedAgentView[];
}) {
  const connection = machineConnection(machine);
  const notices = machineNotices(machine);
  const removed = machine.state === 'revoked';
  const showAddAgentModal = useShowModal('addAgentModal');
  const actions = useDeviceActions(serverId, machine, placed.length);
  const owner = switchServersStore.statusFor(serverId)?.user?.name ?? null;

  return (
    <div className="space-y-4">
      <header className="flex items-start gap-3">
        <MachineIcon machine={machine} className="size-10 rounded-[10px]" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-[20px] font-semibold text-foreground">{machine.name}</h2>
            <TonePill tone="idle" dot={false} label={machineKindLabel(machine)} />
            <TonePill tone={connection.tone} label={connection.label} title={connection.title} />
          </div>
          <p className="truncate text-[13px] text-[var(--fg-dim)]">
            {[owner, machine.description].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions.renamable && (
            <Button size="sm" variant="outline" onClick={actions.rename}>
              <Pencil className="size-3.5" />
              Rename
            </Button>
          )}
          {!removed && (
            <Button
              size="sm"
              variant="outline"
              // The new agent form lists an offline device but cannot place an agent on it.
              disabled={machine.state !== 'online'}
              title={
                machine.state === 'online'
                  ? undefined
                  : 'It can take a new agent once it is online.'
              }
              onClick={() =>
                showAddAgentModal({ entryPoint: 'machine_page', machineId: machine.id })
              }
            >
              <Plus className="size-4" />
              New agent
            </Button>
          )}
          {actions.removable && (
            <Button
              size="sm"
              variant="outline"
              className="text-foreground-error"
              onClick={actions.remove}
            >
              <Trash2 className="size-3.5" />
              Remove
            </Button>
          )}
        </div>
      </header>

      {actions.error && (
        <p role="alert" className="text-sm text-destructive">
          {actions.error}
        </p>
      )}

      {notices.map((notice) => (
        <MessageBox key={notice.key} tone={NOTICE_TONE[notice.tone]} title={notice.title}>
          <p>{notice.body}</p>
        </MessageBox>
      ))}

      <DetailsCard machine={machine} owner={owner} />
      {!removed && (
        <div className="grid grid-cols-3 gap-4">
          <ConnectionCard machine={machine} />
          <SystemCard machine={machine} />
          <SoftwareCard machine={machine} />
        </div>
      )}
      {machine.cloud && !removed && <CloudMachineSection serverId={serverId} machine={machine} />}
      {/* Kept on a removed device: its agents stay placed on it until they are moved. */}
      <AgentsCard machine={machine} placed={placed} />
      {!removed && <MachineProviders serverId={serverId} machine={machine} />}
    </div>
  );
}

/** A label and its value side by side, as the Connection, System and Software cards list them. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-start gap-2 py-1 text-[13px]">
      <dt className="text-[var(--fg-dim)]">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

function DetailsCard({ machine, owner }: { machine: MachineDetail; owner: string | null }) {
  const removedAt = machine.revokedAt ? format(new Date(machine.revokedAt), 'd MMM yyyy') : null;
  return (
    <Card title="Details">
      <dl className="grid grid-cols-5 gap-4 text-[13px]">
        <Fact label="Name">{machine.name}</Fact>
        <Fact label="Description">{machine.description ?? '—'}</Fact>
        <Fact label="Owner">{owner ?? '—'}</Fact>
        <Fact label="Device type">{machineKindLabel(machine)}</Fact>
        {removedAt ? (
          <Fact label="Removed">{removedAt}</Fact>
        ) : (
          <Fact label="Added">
            {machine.createdAt ? format(new Date(machine.createdAt), 'd MMM yyyy') : '—'}
          </Fact>
        )}
      </dl>
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-[var(--fg-dim)]">{label}</dt>
      <dd className="mt-0.5 break-words text-foreground">{children}</dd>
    </div>
  );
}

function ConnectionCard({ machine }: { machine: MachineDetail }) {
  const connection = machineConnection(machine);
  const contact = lastContact(machine, new Date());
  return (
    <Card title="Connection">
      <dl>
        <Row label="State">
          <TonePill tone={connection.tone} label={connection.label} title={connection.title} />
        </Row>
        <Row label="Last seen">
          {machine.state === 'online' ? 'Now' : contact ? agoLabel(contact, new Date()) : 'Never'}
        </Row>
        {machine.local?.kind === 'ssh-host' && (
          <Row label="SSH as">
            <span className="break-all">{machine.local.sshHost}</span>
          </Row>
        )}
        <Row label="Console sign-ins">
          <TonePill
            tone={machine.acceptsLogins ? 'ok' : 'idle'}
            dot={false}
            label={machine.acceptsLogins ? 'Yes' : 'No'}
          />
        </Row>
      </dl>
      {!machine.acceptsLogins && (
        <p className="mt-2 text-[12px] text-[var(--fg-dim)]">
          {machine.local?.kind === 'this-computer'
            ? "It uses this computer's own provider sign-ins."
            : 'Its controller has no key to take a sign-in with: providers sign in on the device itself.'}
        </p>
      )}
    </Card>
  );
}

function Usage({ free, total }: { free: number; total: number }) {
  if (total <= 0) return <>—</>;
  return (
    <div>
      {formatBytes(free)} free of {formatBytes(total)}
      <Progress
        value={Math.round(((total - free) / total) * 100)}
        aria-label="Used"
        className="mt-1.5"
      />
    </div>
  );
}

function SystemCard({ machine }: { machine: MachineDetail }) {
  const resources = machine.resources;
  const platform = machine.platform;
  return (
    <Card title="System">
      {!platform && !resources ? (
        <p className="text-[13px] text-[var(--fg-dim)]">Not reported yet.</p>
      ) : (
        <dl>
          {platform && (
            <>
              <Row label="Operating system">{platformLabel({ ...platform, arch: '' })}</Row>
              <Row label="CPU">{platform.arch}</Row>
            </>
          )}
          {resources && (
            <>
              <Row label="Disk">
                <Usage free={resources.diskFreeBytes} total={resources.diskTotalBytes} />
              </Row>
              <Row label="Memory">
                <Usage free={resources.memFreeBytes} total={resources.memTotalBytes} />
              </Row>
              <Row label="Sessions">
                {resources.sessionsMax > 0
                  ? `${resources.sessionsRunning} of ${resources.sessionsMax} running`
                  : `${resources.sessionsRunning} running now`}
              </Row>
            </>
          )}
        </dl>
      )}
    </Card>
  );
}

function SoftwareCard({ machine }: { machine: MachineDetail }) {
  const release = controllerRelease(machine);
  return (
    <Card title="Software">
      <dl>
        <Row label="Version">
          <span title={release.title} className="flex flex-wrap items-center gap-1.5">
            {machine.version ?? 'Not reported'}
            {release.badge && (
              <TonePill tone={release.badge.tone} dot={false} label={release.badge.label} />
            )}
          </span>
        </Row>
        {machine.updatedBy && (
          <Row label="Updates">
            {machine.updatedBy === 'console' ? 'Updated with Switch Console' : 'Updates itself'}
          </Row>
        )}
        {machine.workspacesDir && (
          <Row label="Workspaces">
            <span className="flex items-start gap-1">
              <code
                className="min-w-0 truncate font-[Menlo,ui-monospace,monospace] text-[11.5px] [direction:rtl]"
                title={machine.workspacesDir}
              >
                <bdi>{machine.workspacesDir}</bdi>
              </code>
              <CopyButton value={machine.workspacesDir} />
            </span>
          </Row>
        )}
      </dl>
    </Card>
  );
}

/**
 * The Switch cloud machine's power and disk, and starting and stopping it, as
 * Your Agents shows them: the cloud machine as Switch runs it, beside the
 * controller on it that this page is about.
 */
function CloudMachineSection({ serverId, machine }: { serverId: string; machine: MachineDetail }) {
  const cloud = useCloudMachines(serverId);
  const hosted = cloud.data?.find((candidate) => candidate.controller_id === machine.id);
  if (cloud.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {failureText(cloud.error, 'Could not read the cloud machine.')}
      </p>
    );
  if (!hosted) return null;
  return <CloudMachineCard machine={hosted} serverId={serverId} />;
}

/**
 * The agents on the device: those placed on it, each opening its page and
 * movable to another device, and any others it reports running, which this
 * person cannot open.
 */
function AgentsCard({ machine, placed }: { machine: MachineDetail; placed: ManagedAgentView[] }) {
  const { navigate } = useNavigate();
  const showMoveModal = useShowModal('moveAgentModal');
  const unlisted = machine.agents.filter(
    (report) => !placed.some((agent) => agent.agentId === report.agentId)
  );
  const count = placed.length + unlisted.length;
  return (
    <Card
      title={count === 0 ? 'Agents' : `Agents · ${count}`}
      subtitle={
        machine.local?.kind === 'this-computer'
          ? 'Agents here only run while this computer is awake and Switch Console is open.'
          : undefined
      }
    >
      {count === 0 ? (
        <p className="text-[13px] text-[var(--fg-dim)]">No agents on it.</p>
      ) : (
        <table className="w-full table-fixed text-[13px]">
          <thead>
            <tr className="text-left text-[12px] text-[var(--fg-dim)]">
              <th className="w-[30%] pb-2 font-normal">Agent</th>
              <th className="w-[14%] pb-2 font-normal">Status</th>
              <th className="pb-2 font-normal">Working folder</th>
              <th className="w-[16%] pb-2 font-normal">Provider</th>
              <th className="w-[112px] pb-2" />
            </tr>
          </thead>
          <tbody>
            {placed.map((agent) => {
              const label = managedAgentLabel(agent);
              const state = managedAgentState(agent);
              const folder = agent.status?.directory ?? agent.definition.directory;
              const open = () =>
                navigate('managedAgent', {
                  serverId: agent.serverId,
                  agentId: agent.agentId,
                  name: label,
                });
              return (
                <tr key={agent.agentId} className="border-t-[0.5px] border-[var(--hair-soft)]">
                  <td className="py-1.5">
                    <button
                      type="button"
                      onClick={open}
                      className="flex max-w-full cursor-pointer items-center gap-2.5 text-left text-foreground underline-offset-2 hover:underline"
                    >
                      <AgentAvatar
                        name={label}
                        iconUrl={agent.iconUrl}
                        serverId={agent.serverId}
                        size={20}
                      />
                      <span className="truncate">{label}</span>
                    </button>
                  </td>
                  <td className="py-1.5">
                    <StateText
                      tone={AGENT_TONE[state.tone]}
                      label={state.label}
                      title={state.detail ?? undefined}
                    />
                  </td>
                  <td
                    className="truncate py-1.5 font-[Menlo,ui-monospace,monospace] text-[11.5px] text-[var(--fg-dim)]"
                    title={folder ?? undefined}
                  >
                    {folder ? shortFolder(folder, machine.workspacesDir) : '—'}
                  </td>
                  <td className="truncate py-1.5 text-foreground">
                    {providerDisplayName(agent.definition.provider) ?? agent.definition.provider}
                  </td>
                  <td className="py-1.5">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => showMoveModal({ agent })}>
                        Move…
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="outline"
                              size="sm"
                              className="size-7 p-0"
                              aria-label={`${label} actions`}
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={open}>
                            <ExternalLink className="size-4" />
                            Open agent
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => showMoveModal({ agent })}>
                            Move to another device…
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              );
            })}
            {unlisted.map((report) => (
              <tr
                key={report.agentId}
                className="border-t-[0.5px] border-[var(--hair-soft)]"
                title="Runs here, but is not one of the agents you can open."
              >
                <td className="truncate py-1.5 font-mono text-[11.5px] text-[var(--fg-dim)]">
                  {report.agentId}
                </td>
                <td className="py-1.5">
                  <StateText
                    tone={PROCESS_TONE[report.process] ?? 'idle'}
                    label={report.process}
                    title={[report.reason, report.detail].filter(Boolean).join(': ') || undefined}
                  />
                </td>
                <td />
                <td />
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function StateText({ tone, label, title }: { tone: MachineTone; label: string; title?: string }) {
  return (
    <span title={title} className={cn('flex items-center gap-1.5', STATE_TEXT[tone])}>
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[tone])} />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * An agent's working folder as its row shows it: inside the device's
 * workspaces folder, which the Software card shows, only the part after it;
 * anywhere else, the whole path.
 */
export function shortFolder(folder: string, workspacesDir: string | null): string {
  if (workspacesDir && folder.startsWith(`${workspacesDir}/`))
    return `…/${folder.slice(workspacesDir.length + 1)}`;
  return folder;
}
