import { MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { isFrozenServer } from '@renderer/features/switch-servers/managed-server-state';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { PageHeader } from '@renderer/lib/components/page-header';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { DisclosureRow } from '@renderer/lib/ui/disclosure-row';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Spinner } from '@renderer/lib/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { cn } from '@renderer/utils/utils';
import type { MachineDetail } from '@shared/core/managed-agents/managed-agents';
import { MachineIcon, TONE_DOT } from './machine-marks';
import {
  arrangeMachines,
  controllerRelease,
  MACHINE_CATEGORY_LABELS,
  type MachineCategory,
  machineCategory,
  machineConnection,
} from './machine-state';
import { useDeviceActions } from './use-device-actions';
import { useMachineDetails } from './use-machines';

type Filter = 'all' | MachineCategory;

/**
 * Settings → Devices: the computers that run the signed-in person's managed
 * agents on the server the window is on, one card each, opening its page.
 * The server returns the whole list in one response, unpaged, and only this
 * person's own devices.
 */
export const DevicesSettingsPage = observer(function DevicesSettingsPage() {
  const serverId = workspacesStore.activeServerId;
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  const [filter, setFilter] = useState<Filter>('all');
  const showAddMachineModal = useShowModal('addMachineModal');

  return (
    <>
      <PageHeader
        sticky
        title="Devices"
        description={`The devices that host your agents on ${server?.name ?? 'this server'}.`}
      >
        <div className="flex items-center justify-between gap-2">
          <ToggleGroup
            multiple={false}
            value={[filter]}
            onValueChange={([value]) => {
              if (value) setFilter(value as Filter);
            }}
          >
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            {(Object.keys(MACHINE_CATEGORY_LABELS) as MachineCategory[]).map((category) => (
              <ToggleGroupItem key={category} value={category}>
                {MACHINE_CATEGORY_LABELS[category]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {serverId && (
            <Button variant="outline" onClick={() => showAddMachineModal({ serverId })}>
              <Plus className="size-4" />
              Add device
            </Button>
          )}
        </div>
      </PageHeader>
      {serverId === null ? (
        <p className="pt-4 text-sm text-foreground-muted">Pick a workspace to see its devices.</p>
      ) : (
        <DevicesBody
          serverId={serverId}
          filter={filter}
          frozen={!!server && isFrozenServer(server)}
        />
      )}
    </>
  );
});

function DevicesBody({
  serverId,
  filter,
  frozen,
}: {
  serverId: string;
  filter: Filter;
  frozen: boolean;
}) {
  const machines = useMachineDetails(serverId);
  const managed = useManagedAgents(serverId);
  const [showRemoved, setShowRemoved] = useState(false);

  if (machines.error && !frozen)
    return (
      <p role="alert" className="pt-4 text-sm text-destructive">
        {failureText(machines.error, 'Could not load your devices.')}
      </p>
    );
  if (machines.data === undefined) return <Spinner className="mt-4" />;
  if (machines.data === null)
    return (
      <p className="pt-4 text-sm text-foreground-muted">
        This server does not have agent management turned on.
      </p>
    );

  const arranged = arrangeMachines(machines.data);
  const shown = (list: MachineDetail[]) =>
    filter === 'all' ? list : list.filter((machine) => machineCategory(machine) === filter);
  const live = shown(arranged.live);
  const removed = shown(arranged.removed);
  const agentsOn = (machine: MachineDetail) =>
    (managed.data ?? []).filter((agent) => agent.machine?.id === machine.id).length;

  return (
    <div className="flex flex-col gap-6 pt-4 pb-10">
      {live.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          {machines.data.length === 0
            ? 'No devices yet. This computer joins when you run a managed agent on it, and so does an SSH host; a standalone machine joins once it is enrolled.'
            : `No ${filter === 'all' ? '' : `${MACHINE_CATEGORY_LABELS[filter as MachineCategory].toLowerCase()} `}devices.`}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {live.map((machine) => (
            <DeviceCard
              key={machine.id}
              serverId={serverId}
              machine={machine}
              agentCount={agentsOn(machine)}
            />
          ))}
        </div>
      )}
      {removed.length > 0 && (
        <div>
          <DisclosureRow
            open={showRemoved}
            title="Removed"
            summary="Devices removed from Switch"
            meta={removed.length}
            onToggle={() => setShowRemoved((open) => !open)}
          />
          {showRemoved && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              {removed.map((machine) => (
                <DeviceCard
                  key={machine.id}
                  serverId={serverId}
                  machine={machine}
                  agentCount={agentsOn(machine)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One device: what it is, whether it is connected, its name, and what runs on it. */
function DeviceCard({
  serverId,
  machine,
  agentCount,
}: {
  serverId: string;
  machine: MachineDetail;
  agentCount: number;
}) {
  const { navigate } = useNavigate();
  const connection = machineConnection(machine);
  const badge = machine.state === 'revoked' ? null : controllerRelease(machine).badge;
  const actions = useDeviceActions(serverId, machine, agentCount);
  const open = () => navigate('machine', { serverId, machineId: machine.id, name: machine.name });

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      className="flex min-w-0 cursor-pointer flex-col gap-3 rounded-[10px] border border-border bg-background p-4 text-left transition-colors hover:bg-[var(--fill)]"
    >
      <div className="flex items-center gap-2">
        <MachineIcon machine={machine} className="size-6 border-0 bg-transparent" />
        <span
          title={`${connection.label}: ${connection.title}`}
          aria-label={connection.label}
          className={cn('size-1.5 rounded-full', TONE_DOT[connection.tone])}
        />
        {badge && (
          <span
            title={controllerRelease(machine).title}
            className="text-[11px] text-foreground-warning"
          >
            {badge.label}
          </span>
        )}
        <span className="flex-1" />
        {(actions.renamable || actions.removable) && (
          // A click on the menu is not a click on the card.
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-7 p-0"
                    aria-label={`${machine.name} actions`}
                  >
                    <MoreVertical className="size-4" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                {actions.renamable && (
                  <DropdownMenuItem onClick={actions.rename}>
                    <Pencil className="size-4" />
                    Rename
                  </DropdownMenuItem>
                )}
                {actions.removable && (
                  <DropdownMenuItem variant="destructive" onClick={actions.remove}>
                    <Trash2 className="size-4" />
                    Remove…
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm text-foreground">
          {machine.local?.kind === 'this-computer'
            ? `${machine.name} (this computer)`
            : machine.name}
        </div>
        <div className="truncate text-sm text-foreground-muted">
          {agentCount === 0
            ? 'No agents'
            : `${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}`}
        </div>
      </div>
      {actions.error && (
        <p role="alert" className="text-xs text-destructive">
          {actions.error}
        </p>
      )}
    </div>
  );
}
