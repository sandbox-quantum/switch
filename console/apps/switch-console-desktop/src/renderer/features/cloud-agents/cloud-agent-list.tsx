import type { Session } from '@switch-console/shared/session-v1';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Cloud, MessageSquare, Plus } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { restartsOnSend } from '@renderer/features/sessions/components/transcript/session-state';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { type CloudAgent, cloudMachineReady } from '@shared/core/cloud-agents/cloud-agents';
import { SidebarMenuButton } from '../sidebar/sidebar-primitives';
import { cloudAgentState } from './cloud-agent-state';
import { cloudOperationAttempts, startAttemptKey } from './cloud-operation-attempts';
import { CloudProblem } from './cloud-problem';
import { CloudStartAttemptStatus } from './cloud-start-attempt-status';
import {
  serverNotSignedIn,
  useCloudAgentSessions,
  useCloudAgents,
  useCloudProblemAction,
} from './use-cloud-agents';

export function cloudSessionName(session: Session): string {
  const room = session.roomIds?.[0];
  const roomName = room ? switchRoomsStore.roomNameById(room) : null;
  return roomName ?? `Session ${session.sessionId.slice(0, 8)}`;
}

/**
 * Whether an agent's worker cannot be asked because of its machine rather than
 * itself: every agent on that machine says the same, so it is said once.
 */
function isMachineProblem(agent: CloudAgent): boolean {
  const code = agent.problem?.code;
  if (code === 'worker_waking') return !cloudMachineReady(agent.machine);
  return code === 'worker_sleeping' || code === 'machine_stopped' || code === 'machine_error';
}

/** The machines whose state keeps their agents' workers from being asked, one agent each. */
function machineProblems(agents: CloudAgent[]): CloudAgent[] {
  const byMachine = new Map<string, CloudAgent>();
  for (const agent of agents.filter(isMachineProblem)) {
    const machineId = agent.machine?.machine_id ?? agent.launch.machine_id ?? '';
    const shown = byMachine.get(machineId);
    if (!shown || (agent.problem!.wakeAvailable && !shown.problem!.wakeAvailable))
      byMachine.set(machineId, agent);
  }
  return [...byMachine.values()];
}

/**
 * The active server's cloud agents under the local and SSH ones: each launch,
 * and beneath it the sessions its worker reports. A machine whose state keeps
 * its agents' workers from being asked says so once, above them; a launch
 * whose worker cannot be asked for its own reason says why, above the sessions
 * last read from it. A worker is asked for its sessions only while its row is
 * expanded or one of its sessions is open.
 */
export const CloudAgentList = observer(function CloudAgentList() {
  const serverId = switchServersStore.activeServerId;
  const agents = useCloudAgents(serverId);
  const queryClient = useQueryClient();
  useEffect(() => {
    const onFocus = () => void queryClient.invalidateQueries({ queryKey: ['cloud-agents'] });
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [queryClient]);
  if (serverNotSignedIn(serverId)) return null;
  if (agents.error)
    return (
      <div role="alert" className="px-3 py-2 text-xs text-foreground-destructive">
        Cloud agents could not be listed: {String(agents.error)}
      </div>
    );
  if (!agents.data?.length) return null;
  return (
    <div className="mt-2 flex flex-col gap-[2px]" aria-label="Cloud agents">
      {machineProblems(agents.data).map((agent) => (
        <CloudMachineProblem key={agent.key} agent={agent} />
      ))}
      {agents.data.map((agent) => (
        <CloudAgentRow key={agent.key} listed={agent} />
      ))}
    </div>
  );
});

function CloudMachineProblem({ agent }: { agent: CloudAgent }) {
  const action = useCloudProblemAction(agent, true);
  return (
    <CloudProblem
      problem={agent.problem!}
      machineReady={cloudMachineReady(agent.machine)}
      compact
      action={action}
    />
  );
}

const CloudAgentRow = observer(function CloudAgentRow({ listed }: { listed: CloudAgent }) {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params } = useParams('cloudSession');
  const groupKey = `cloud:${listed.key}`;
  const expanded = sidebarStore.isCloudGroupExpanded(groupKey);
  const attemptKey = startAttemptKey(listed.key);
  const attempt = cloudOperationAttempts.get(attemptKey);
  const agent = useCloudAgentSessions(
    listed,
    expanded ||
      (currentView === 'cloudSession' && params.agentKey === listed.key) ||
      attempt?.status === 'unknown'
  );
  const label = cloudAgentState(agent)?.label;
  const queryClient = useQueryClient();
  const [startError, setStartError] = useState<string | null>(null);
  const openSession = (sessionId: string) =>
    navigate('cloudSession', {
      agentKey: agent.key,
      sessionId,
      name: `${agent.launch.name} · Session ${sessionId.slice(0, 8)}`,
    });
  const start = async () => {
    setStartError(null);
    const result = await cloudOperationAttempts.run(attemptKey, agent.key, 'start', null);
    if (!result) return;
    if (result.outcome.state === 'applied') openSession(result.sessionId);
    else if (result.outcome.state === 'failed') setStartError(result.outcome.message);
    else void queryClient.invalidateQueries({ queryKey: ['cloud-agents'] });
  };
  const sessions = (agent.sessions ?? []).filter((session) => !session.retired);
  return (
    <div>
      <div className="group/row flex items-center">
        <SidebarMenuButton
          aria-expanded={expanded}
          onClick={() => sidebarStore.toggleCloudGroupExpanded(groupKey)}
        >
          <ChevronRight className={`size-3 shrink-0 ${expanded ? 'rotate-90' : ''}`} />
          <Cloud className="size-3.5 shrink-0" />
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{agent.launch.name}</span>
            {!sidebarStore.hideProviderMark && (
              <AgentIcon id={agent.launch.provider} size={12} className="h-3 w-3 shrink-0" />
            )}
          </span>
          {label && (
            <span className="ml-auto text-xs text-foreground-muted capitalize">{label}</span>
          )}
        </SidebarMenuButton>
        {!agent.problem && (
          <button
            type="button"
            aria-label={`New session on ${agent.launch.name}`}
            title="New session"
            className="rounded p-1 text-foreground-muted hover:text-foreground disabled:opacity-50"
            disabled={attempt?.status === 'pending'}
            onClick={() => void start()}
          >
            <Plus className="size-3.5" />
          </button>
        )}
      </div>
      {startError && (
        <div role="alert" className="px-7 py-1 text-xs text-foreground-destructive">
          The session could not be started: {startError}
        </div>
      )}
      <CloudStartAttemptStatus
        agentKey={agent.key}
        sessions={sessions}
        onOpen={openSession}
        onCheckAgain={() => void start()}
        className="px-7 py-1"
      />
      {expanded && (
        <div className="flex flex-col gap-[2px] pl-5">
          {agent.problem && !isMachineProblem(agent) && (
            <CloudProblem
              problem={agent.problem}
              machineReady={cloudMachineReady(agent.machine)}
              compact
              action={null}
            />
          )}
          {agent.sessions && sessions.length === 0 && (
            <p className="px-2 py-1 text-xs text-foreground-muted">No sessions on this worker.</p>
          )}
          {sessions.map((session) => (
            <SidebarMenuButton
              key={session.sessionId}
              isActive={
                currentView === 'cloudSession' &&
                params.agentKey === agent.key &&
                params.sessionId === session.sessionId
              }
              onClick={() =>
                navigate('cloudSession', {
                  agentKey: agent.key,
                  sessionId: session.sessionId,
                  name: `${agent.launch.name} · ${cloudSessionName(session)}`,
                })
              }
            >
              <MessageSquare className="size-3.5 shrink-0" />
              <span className="truncate">{cloudSessionName(session)}</span>
              <span className="ml-auto text-xs text-foreground-muted">
                {restartsOnSend(session) ? null : session.status}
              </span>
            </SidebarMenuButton>
          ))}
        </div>
      )}
    </div>
  );
});
