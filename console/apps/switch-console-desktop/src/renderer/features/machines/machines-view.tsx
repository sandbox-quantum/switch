import { Plus, Server } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { isFrozenServer } from '@renderer/features/switch-servers/managed-server-state';
import { ServerPage, ServerTableEmpty } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { DisclosureRow } from '@renderer/lib/ui/disclosure-row';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { MachineDetail, ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { MachineIcon, TonePill } from './machine-marks';
import {
  arrangeMachines,
  controllerRelease,
  filterMachines,
  machineConnection,
  machineSummary,
} from './machine-state';
import { useMachineDetails } from './use-machines';

function useServerId(): string {
  return useParams('machines').params.serverId;
}

const MachinesTitlebar = observer(function MachinesTitlebar() {
  return <ServerSectionTitlebar serverId={useServerId()} icon={Server} label="Your Machines" />;
});

/**
 * The computers that run the signed-in person's managed agents on this
 * server: this computer, their SSH hosts, headless controllers and a Switch
 * cloud machine. One row each, opening the machine's own page; removed
 * machines are folded away at the end. Read-only for now.
 *
 * The server returns the whole list in one response, unpaged, and it holds
 * only this person's own machines, so the filter runs over all of them here.
 */
const MachinesPanel = observer(function MachinesPanel() {
  const serverId = useServerId();
  const server = switchServersStore.servers.find((s) => s.id === serverId);
  const machines = useMachineDetails(serverId);
  const managed = useManagedAgents(serverId);
  const showAddMachineModal = useShowModal('addMachineModal');

  return (
    <ServerPage
      width={880}
      title="Your Machines"
      description={`Computers running an agents controller for you on ${server?.name ?? 'this server'}. Each runs the agents you place on it and reports what it sees.`}
      action={
        machines.data ? (
          <Button size="sm" onClick={() => showAddMachineModal({ serverId })}>
            <Plus className="size-4" />
            Add machine
          </Button>
        ) : undefined
      }
    >
      {machines.error && !(server && isFrozenServer(server)) ? (
        <p role="alert" className="text-sm text-destructive">
          {failureText(machines.error, 'Could not load your machines.')}
        </p>
      ) : machines.data === undefined ? (
        <Spinner />
      ) : machines.data === null ? (
        <ServerTableEmpty>
          {server?.name ?? 'This server'} does not have agent management turned on.
        </ServerTableEmpty>
      ) : (
        <MachineList serverId={serverId} machines={machines.data} agents={managed.data ?? []} />
      )}
    </ServerPage>
  );
});

function MachineList({
  serverId,
  machines,
  agents,
}: {
  serverId: string;
  machines: MachineDetail[];
  /** The person's managed agents, wherever each is placed. */
  agents: ManagedAgentView[];
}) {
  const [filter, setFilter] = useState('');
  const [showRemoved, setShowRemoved] = useState(false);
  const arranged = arrangeMachines(machines);
  const live = filterMachines(arranged.live, filter);
  const removed = filterMachines(arranged.removed, filter);
  const filtering = filter.trim() !== '';
  const placedOn = (machine: MachineDetail) =>
    agents.filter((agent) => agent.machine?.id === machine.id).length;

  if (machines.length === 0)
    return (
      <ServerTableEmpty>
        No machines yet. This computer joins when you run a managed agent on it, and so does an SSH
        host; a headless agents controller joins once it is enrolled.
      </ServerTableEmpty>
    );

  return (
    <div className="flex flex-col gap-6">
      <SearchInput
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter machines…"
        aria-label="Filter machines by name, description or kind"
      />
      {live.length === 0 && removed.length === 0 ? (
        <p className="py-2 text-sm text-foreground-muted">
          No machine here matches “{filter.trim()}”.
        </p>
      ) : (
        <>
          {live.length > 0 && (
            <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
              {live.map((machine) => (
                <MachineRow
                  key={machine.id}
                  serverId={serverId}
                  machine={machine}
                  agentCount={placedOn(machine)}
                />
              ))}
            </div>
          )}
          {removed.length > 0 && (
            <div>
              <DisclosureRow
                // A filter that only matches removed machines would otherwise
                // show nothing but a closed fold.
                open={showRemoved || (filtering && live.length === 0)}
                title="Removed"
                summary="Machines revoked from Switch"
                meta={removed.length}
                onToggle={() => setShowRemoved((open) => !open)}
              />
              {(showRemoved || (filtering && live.length === 0)) && (
                <div className="mt-2 divide-y divide-border overflow-hidden rounded-[10px] border border-border">
                  {removed.map((machine) => (
                    <MachineRow
                      key={machine.id}
                      serverId={serverId}
                      machine={machine}
                      agentCount={placedOn(machine)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One machine: what it is and what runs on it, whether it is connected, and a way into its page. */
function MachineRow({
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
  const badge = controllerRelease(machine).badge;
  return (
    <button
      type="button"
      onClick={() => navigate('machine', { serverId, machineId: machine.id, name: machine.name })}
      className="flex w-full cursor-pointer items-center gap-3 bg-background px-4 py-3 text-left transition-colors hover:bg-[var(--fill)]"
    >
      <MachineIcon machine={machine} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-sm font-medium text-foreground">
          {machine.name}
        </span>
        <span className="truncate text-xs text-foreground-muted">
          {machineSummary(machine, agentCount)}
        </span>
      </div>
      {badge && machine.state !== 'revoked' && (
        <TonePill tone={badge.tone} label={badge.label} dot={false} />
      )}
      <TonePill tone={connection.tone} label={connection.label} title={connection.title} />
    </button>
  );
}

export const machinesView = {
  WrapView: ({ children }: { children: React.ReactNode; serverId: string }) => <>{children}</>,
  TitlebarSlot: MachinesTitlebar,
  MainPanel: MachinesPanel,
  canActivate: (params: unknown): GuardResult => {
    const serverId =
      typeof params === 'object' && params !== null
        ? (params as { serverId?: unknown }).serverId
        : undefined;
    if (typeof serverId !== 'string') return { ok: false, redirect: 'home' };
    return { ok: true };
  },
} satisfies ViewDefinition<{ serverId: string }>;
