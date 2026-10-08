import { Server, ServerOff } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { isValidProviderId } from '@shared/core/providers/agent-provider-registry';
import { type AgentPresence, SidebarAgentRow } from '../sidebar/agent-row';
import {
  type ManagedAgentState,
  managedAgentLabel,
  managedAgentState,
} from './managed-agent-state';
import { useManagedAgents, useOwnedMachines } from './use-managed-agents';

/**
 * The active server's managed agents: every one the server lists, whatever
 * machine it runs on and wherever it was created, in the same rows as the
 * agents this Console runs.
 */
export const ManagedAgentList = observer(function ManagedAgentList() {
  const serverId = switchServersStore.activeServerId;
  const agents = useManagedAgents(serverId);
  if (serverId === null) return null;
  if (agents.error)
    return (
      <div role="alert" className="px-3 py-2 text-xs text-foreground-destructive">
        {failureText(agents.error, 'Managed agents could not be listed.')}
      </div>
    );
  if (!agents.data?.length) return null;
  return (
    <div className="flex flex-col gap-[2px]" aria-label="Managed agents">
      {agents.data.map((agent) => (
        <ManagedAgentRow key={agent.agentId} agent={agent} />
      ))}
    </div>
  );
});

const ManagedAgentRow = observer(function ManagedAgentRow({ agent }: { agent: ManagedAgentView }) {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params } = useParams('managedAgent');
  const machines = useOwnedMachines(agent.serverId);
  const label = managedAgentLabel(agent);
  const provider = agent.definition.provider;
  const state = managedAgentState(agent);
  const thisComputer =
    machines.data?.find((machine) => machine.id === agent.machine?.id)?.local?.kind ===
    'this-computer';
  const machineDown = agent.machine !== null && agent.machine.state !== 'online';
  return (
    <SidebarAgentRow
      label={label}
      iconUrl={agent.iconUrl}
      providerId={isValidProviderId(provider) ? provider : null}
      isActive={currentView === 'managedAgent' && params.agentId === agent.agentId}
      depth={0}
      onOpen={() =>
        navigate('managedAgent', { serverId: agent.serverId, agentId: agent.agentId, name: label })
      }
      presence={{
        tone: PRESENCE_TONE[state.tone],
        label: state.detail ? `${state.label}: ${state.detail}` : state.label,
      }}
      dimmed={machineDown}
      marks={
        !thisComputer && (
          <Tooltip>
            <TooltipTrigger>
              {machineDown || !agent.machine ? (
                <ServerOff className="h-3.5 w-3.5 shrink-0 text-foreground-destructive" />
              ) : (
                <Server className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />
              )}
            </TooltipTrigger>
            <TooltipContent>
              {agent.machine
                ? machineDown
                  ? `${agent.machine.name} is ${agent.machine.state}. The agent resumes when it reconnects.`
                  : `Runs on ${agent.machine.name}${agent.definition.directory ? ` · ${agent.definition.directory}` : ''}`
                : 'It has no machine to run on.'}
            </TooltipContent>
          </Tooltip>
        )
      }
      status={null}
      actions={null}
    />
  );
});

const PRESENCE_TONE: Record<ManagedAgentState['tone'], AgentPresence['tone']> = {
  ok: 'running',
  idle: 'stopped',
  problem: 'problem',
  busy: 'pending',
};
