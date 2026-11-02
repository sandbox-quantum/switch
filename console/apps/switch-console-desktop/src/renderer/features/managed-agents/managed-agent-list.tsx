import { Cloud, CloudOff, Server, ServerOff } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { byLatestDirectChat } from '@renderer/features/chats/agent-conversations';
import { chatsStore } from '@renderer/features/chats/stores/chats';
import { useResealResult } from '@renderer/features/cloud-agents/repair-cloud';
import { useCloudMachineFor } from '@renderer/features/cloud-agents/use-cloud-agents';
import {
  type SharedCloudTone,
  sharedCloudFromSession,
  sharedCloudPresentation,
  showsSharedCloudState,
} from '@renderer/features/shared-cloud/shared-cloud-state';
import { useSharedCloudAgents } from '@renderer/features/shared-cloud/use-shared-cloud';
import { isFrozenServer } from '@renderer/features/switch-servers/managed-server-state';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { isCloudMachine, type ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { getProvider, isValidProviderId } from '@shared/core/providers/agent-provider-registry';
import type { SharedCloudAgent } from '@shared/core/shared-cloud/shared-cloud';
import { type AgentPresence, SidebarAgentRow } from '../sidebar/agent-row';
import {
  type ManagedAgentState,
  managedAgentLabel,
  managedAgentState,
} from './managed-agent-state';
import { useManagedAgents, useOnSharedCloudBox, useRunsOnThisComputer } from './use-managed-agents';

/**
 * The active server's managed agents: every one the server lists, whatever
 * machine it runs on and wherever it was created, in the same rows as the
 * agents this Console runs.
 */
export const ManagedAgentList = observer(function ManagedAgentList() {
  const serverId = switchServersStore.activeServerId;
  const agents = useManagedAgents(serverId);
  // On the shared cloud an agent's state comes from there, so the row says
  // the same as its card on Your Agents.
  const shared = useSharedCloudAgents(serverId);
  const sharedById = new Map((shared.data ?? []).map((entry) => [entry.agent_id, entry]));
  if (serverId === null) return null;
  // A frozen workspace's banner already says why nothing can be listed.
  const server = switchServersStore.serverById(serverId);
  if (agents.error && !(server && isFrozenServer(server)))
    return (
      <div role="alert" className="px-3 py-2 text-xs text-foreground-destructive">
        {failureText(agents.error, 'Managed agents could not be listed.')}
      </div>
    );
  if (!agents.data?.length) return null;
  // The chats store follows one server, and only while agent_chats is on there.
  const chats =
    chatsStore.serverId === serverId && chatsStore.userId !== null
      ? chatsStore.chats.values()
      : null;
  return (
    <div className="flex flex-col gap-[2px]" aria-label="Managed agents">
      {disconnectedLast(byLatestDirectChat(agents.data, chats)).map((agent) => (
        <ManagedAgentRow
          key={agent.agentId}
          agent={agent}
          shared={sharedById.get(agent.agentId) ?? null}
        />
      ))}
    </div>
  );
});

/**
 * The agents in the order the server listed them, with the ones that cannot
 * run right now — no machine, or a machine that is offline or removed — at the
 * bottom, where they stay out of the way of the agents that can.
 */
export function disconnectedLast(agents: ManagedAgentView[]): ManagedAgentView[] {
  const disconnected = (agent: ManagedAgentView) =>
    agent.machine === null || agent.machine.state !== 'online';
  return [...agents.filter((agent) => !disconnected(agent)), ...agents.filter(disconnected)];
}

const ManagedAgentRow = observer(function ManagedAgentRow({
  agent,
  shared,
}: {
  agent: ManagedAgentView;
  /** Its state as the shared-cloud service reports it; null to work it out from the agent's own status. */
  shared: SharedCloudAgent | null;
}) {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params } = useParams('managedAgent');
  const label = managedAgentLabel(agent);
  const provider = agent.definition.provider;
  const state = managedAgentState(agent);
  const thisComputer = useRunsOnThisComputer(agent);
  const onSharedBox = useOnSharedCloudBox(agent);
  const box = useCloudMachineFor(agent);
  const resealResult = useResealResult(agent.serverId, box);
  const sharedState =
    shared ?? sharedCloudFromSession(agent, onSharedBox, box, resealResult !== undefined);
  const machineDown = agent.machine !== null && agent.machine.state !== 'online';
  const providerName = isValidProviderId(provider) ? getProvider(provider)?.name : null;
  // On the shared cloud, a resting, waking or failed agent says so here as on
  // its card. Otherwise the row is the same as anywhere else.
  const sharedShown =
    sharedState && showsSharedCloudState(sharedState)
      ? sharedCloudPresentation(sharedState, new Date())
      : null;
  return (
    <SidebarAgentRow
      label={label}
      iconUrl={agent.iconUrl}
      serverId={agent.serverId}
      providerId={isValidProviderId(provider) ? provider : null}
      isActive={currentView === 'managedAgent' && params.agentId === agent.agentId}
      depth={0}
      onOpen={() =>
        navigate('managedAgent', { serverId: agent.serverId, agentId: agent.agentId, name: label })
      }
      presence={
        sharedShown
          ? {
              tone: SHARED_PRESENCE[sharedShown.tone],
              label: `${sharedShown.label}: ${sharedShown.detail}`,
            }
          : {
              tone: PRESENCE_TONE[state.tone],
              label: state.detail ? `${state.label}: ${state.detail}` : state.label,
            }
      }
      dimmed={machineDown || (sharedShown ? sharedShown.tone === 'resting' : state.tone === 'idle')}
      showProviderMark={false}
      title={providerName ? `${label} · ${providerName}` : label}
      marks={
        // A resting, waking or failed shared-cloud agent shows a plain cloud
        // here: its state is in the dot and the hover text, said once, and a
        // machine mark must not contradict it.
        sharedShown ? (
          <Tooltip>
            <TooltipTrigger>
              <Cloud className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />
            </TooltipTrigger>
            <TooltipContent>{`${sharedShown.label}: ${sharedShown.detail}`}</TooltipContent>
          </Tooltip>
        ) : (
          !thisComputer && (
            <Tooltip>
              <TooltipTrigger>
                {agent.machine && isCloudMachine(agent.machine) ? (
                  machineDown ? (
                    <CloudOff className="h-3.5 w-3.5 shrink-0 text-foreground-destructive" />
                  ) : (
                    <Cloud className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />
                  )
                ) : machineDown || !agent.machine ? (
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

/** Working and idle both read as up; resting is at rest, waking on its way. */
const SHARED_PRESENCE: Record<SharedCloudTone, AgentPresence['tone']> = {
  working: 'running',
  idle: 'running',
  resting: 'stopped',
  waking: 'pending',
  problem: 'problem',
  // Turned off by an admin: at rest, grey, not an error the person can fix.
  off: 'stopped',
};
