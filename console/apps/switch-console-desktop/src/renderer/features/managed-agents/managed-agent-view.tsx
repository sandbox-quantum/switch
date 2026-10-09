import { useQueryClient } from '@tanstack/react-query';
import { MoreVertical, Play, Square, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type ReactNode, useState } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { ServerPage } from '@renderer/features/switch-servers/server-page';
import { ServerStatusPill } from '@renderer/features/switch-servers/server-presentation';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { TitlebarBreadcrumb } from '@renderer/lib/components/titlebar/titlebar-breadcrumb';
import { describeFailure, failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { ManagedAgentPage } from './managed-agent-page';
import { managedAgentLabel } from './managed-agent-state';
import { MANAGED_AGENTS_KEY, useManagedAgents } from './use-managed-agents';

type ManagedAgentParams = { serverId: string; agentId: string; name: string };

const ManagedAgentTitlebar = observer(function ManagedAgentTitlebar() {
  const { params } = useParams('managedAgent');
  const agents = useManagedAgents(params.serverId);
  const agent = agents.data?.find((listed) => listed.agentId === params.agentId) ?? null;
  const server = switchServersStore.servers.find((s) => s.id === params.serverId) ?? null;
  const label = agent ? managedAgentLabel(agent) : params.name;
  return (
    <Titlebar
      leftSlot={
        <TitlebarBreadcrumb
          crumbs={[
            {
              key: 'agent',
              icon: (
                <AgentAvatar
                  name={label}
                  iconUrl={agent?.iconUrl ?? null}
                  size={16}
                  className="bg-transparent"
                />
              ),
              label,
            },
          ]}
        />
      }
      rightSlot={
        <div className="mr-1 flex items-center gap-1.5">
          {server && <ServerStatusPill server={server} />}
          {agent && <ManagedAgentActionsMenu agent={agent} />}
        </div>
      }
    />
  );
});

/** Starting, stopping and deleting the agent, from the titlebar's menu as a Console agent's actions are. */
function ManagedAgentActionsMenu({ agent }: { agent: ManagedAgentView }) {
  const label = managedAgentLabel(agent);
  const queryClient = useQueryClient();
  const { navigate } = useNavigate();
  const confirm = useShowModal('confirmActionModal');
  const [busy, setBusy] = useState(false);

  const act = async (fallback: string, run: () => Promise<void>) => {
    setBusy(true);
    try {
      await run();
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY] });
    } catch (failure) {
      const { headline, detail } = describeFailure(failure, fallback);
      toast({ title: headline, description: detail ?? undefined, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };
  const setDesiredState = (desiredState: 'running' | 'stopped') =>
    act(
      desiredState === 'running'
        ? `${label} could not be started.`
        : `${label} could not be stopped.`,
      () =>
        rpc.managedAgents.setDesiredState({
          serverId: agent.serverId,
          agentId: agent.agentId,
          desiredState,
        })
    );
  const remove = () =>
    confirm({
      title: `Delete ${label}?`,
      description: `Its machine stops it and it is deleted from Switch, for every room it is in.`,
      confirmLabel: 'Delete',
      onSuccess: () =>
        void act(`${label} could not be deleted.`, async () => {
          await rpc.managedAgents.remove({ serverId: agent.serverId, agentId: agent.agentId });
          // Its name is free again: the New agent form checks names against this list.
          await queryClient.invalidateQueries({ queryKey: ['workspace-agents'] });
          navigate('serverAgents', { serverId: agent.serverId });
        }),
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm" className="size-7 p-0" aria-label={`${label} actions`}>
            <MoreVertical className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {agent.desiredState === 'running' ? (
          <DropdownMenuItem disabled={busy} onClick={() => void setDesiredState('stopped')}>
            <Square className="size-4" />
            Stop
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled={busy} onClick={() => void setDesiredState('running')}>
            <Play className="size-4" />
            Start
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={busy} onClick={remove}>
          <Trash2 className="size-4" />
          Delete agent…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ManagedAgentPanel = observer(function ManagedAgentPanel() {
  const { params } = useParams('managedAgent');
  const agents = useManagedAgents(params.serverId);
  const agent = agents.data?.find((listed) => listed.agentId === params.agentId);
  if (agents.error)
    return (
      <ServerPage width={900} title={params.name} description="">
        <p role="alert" className="text-sm text-destructive">
          {failureText(agents.error, 'The agent could not be read from its server.')}
        </p>
      </ServerPage>
    );
  if (agents.data === null)
    return (
      <ServerPage width={900} title={params.name} description="">
        <p role="alert" className="text-sm text-destructive">
          This server no longer runs managed agents.
        </p>
      </ServerPage>
    );
  if (!agents.data)
    return (
      <ServerPage width={900} title={params.name} description="Loading…">
        {null}
      </ServerPage>
    );
  if (!agent)
    return (
      <ServerPage width={900} title={params.name} description="">
        <p role="alert" className="text-sm text-destructive">
          This agent is no longer on its Switch server.
        </p>
      </ServerPage>
    );
  return <ManagedAgentPage key={agent.agentId} agent={agent} />;
});

export const managedAgentView = {
  WrapView: ({ children }: ManagedAgentParams & { children: ReactNode }) => <>{children}</>,
  TitlebarSlot: ManagedAgentTitlebar,
  MainPanel: ManagedAgentPanel,
  canActivate: (params: unknown): GuardResult => {
    const value = (params ?? {}) as Partial<Record<keyof ManagedAgentParams, unknown>>;
    if (
      typeof value.serverId !== 'string' ||
      typeof value.agentId !== 'string' ||
      typeof value.name !== 'string'
    )
      return { ok: false, redirect: 'home', discardParams: true };
    return { ok: true };
  },
} satisfies ViewDefinition<ManagedAgentParams>;
