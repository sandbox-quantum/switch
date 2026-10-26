import { Server } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { useManagedAgents } from '@renderer/features/managed-agents/use-managed-agents';
import { isFrozenServer } from '@renderer/features/switch-servers/managed-server-state';
import { ServerTableEmpty } from '@renderer/features/switch-servers/server-page';
import { ServerSectionTitlebar } from '@renderer/features/switch-servers/server-section-titlebar';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { Spinner } from '@renderer/lib/ui/spinner';
import { MachineDetails } from './machine-details';
import { useMachineDetails } from './use-machines';

type MachineParams = { serverId: string; machineId: string; name: string };

const MachineTitlebar = observer(function MachineTitlebar() {
  const { params } = useParams('machine');
  const { navigate } = useNavigate();
  return (
    <ServerSectionTitlebar
      serverId={params.serverId}
      icon={Server}
      label="Your Machines"
      onSectionClick={() => navigate('machines', { serverId: params.serverId })}
      item={{ label: params.name }}
    />
  );
});

/**
 * One of the person's machines, with everything it last reported. Read from
 * the same list as the machines page: the server has no call for one machine.
 */
const MachinePanel = observer(function MachinePanel() {
  const { params } = useParams('machine');
  const server = switchServersStore.servers.find((s) => s.id === params.serverId);
  const machines = useMachineDetails(params.serverId);
  const managed = useManagedAgents(params.serverId);
  const machine = machines.data?.find((m) => m.id === params.machineId);

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <div className="mx-auto w-full max-w-[720px] px-6 pt-10 pb-10">
          {machines.error && !(server && isFrozenServer(server)) ? (
            <p role="alert" className="text-sm text-destructive">
              {failureText(machines.error, 'Could not load this machine.')}
            </p>
          ) : machines.data === undefined ? (
            <Spinner />
          ) : machines.data === null ? (
            <ServerTableEmpty>
              {server?.name ?? 'This server'} does not have agent management turned on.
            </ServerTableEmpty>
          ) : !machine ? (
            <ServerTableEmpty>
              {params.name} is no longer one of your machines on {server?.name ?? 'this server'}.
            </ServerTableEmpty>
          ) : (
            <MachineDetails
              serverId={params.serverId}
              machine={machine}
              placed={(managed.data ?? []).filter((agent) => agent.machine?.id === machine.id)}
            />
          )}
        </div>
      </div>
    </div>
  );
});

export const machineView = {
  WrapView: ({ children }: MachineParams & { children: React.ReactNode }) => <>{children}</>,
  TitlebarSlot: MachineTitlebar,
  MainPanel: MachinePanel,
  canActivate: (params: unknown): GuardResult => {
    const value = (params ?? {}) as Partial<Record<keyof MachineParams, unknown>>;
    if (
      typeof value.serverId !== 'string' ||
      typeof value.machineId !== 'string' ||
      typeof value.name !== 'string'
    )
      return { ok: false, redirect: 'home', discardParams: true };
    return { ok: true };
  },
} satisfies ViewDefinition<MachineParams>;
