import { SessionChatClient } from '@switch-console/shared/session-v1';
import { Cloud } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useMemo, type ReactNode } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { SessionV1Chat } from '@renderer/features/sessions/components/transcript/session-v1-chat';
import { cloudSessionTransport } from '@renderer/features/sessions/components/transcript/shared-session-transport';
import {
  SessionHeaderOutlet,
  SessionHeaderSlotsProvider,
} from '@renderer/features/sessions/session-header-slots';
import { switchCloudFeature } from '@renderer/features/switch-servers/switch-cloud-feature';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import {
  type CloudAgent,
  cloudAgentPhase,
  cloudMachineReady,
  parseCloudAgentKey,
} from '@shared/core/cloud-agents/cloud-agents';
import { cloudAgentState, cloudHoldBlocker } from './cloud-agent-state';
import { cloudOperationAttempts, restartAttemptKey } from './cloud-operation-attempts';
import { CloudProblem } from './cloud-problem';
import {
  useCloudAgentSessions,
  useCloudAgents,
  useCloudProblemAction,
  useCloudWake,
} from './use-cloud-agents';

type CloudSessionParams = { agentKey: string; sessionId: string; name: string };

function CloudSessionTitlebar() {
  const { params } = useParams('cloudSession');
  return (
    <Titlebar
      leftSlot={
        <div className="flex items-center gap-2">
          <Cloud className="size-4" />
          <span>{params.name}</span>
          <SessionHeaderOutlet slot="left" className="flex items-center gap-2" />
        </div>
      }
      rightSlot={<SessionHeaderOutlet slot="right" className="mr-2 flex items-center gap-2" />}
    />
  );
}

/** The agent's state over the transcript while it cannot be asked. */
const CloudWorkerStatus = observer(function CloudWorkerStatus({
  agentKey,
  agent,
}: {
  agentKey: string;
  agent: CloudAgent | undefined;
}) {
  const agents = useCloudAgents(parseCloudAgentKey(agentKey)?.serverId ?? null);
  if (agents.error)
    return (
      <div role="alert" className="px-5 pt-3 text-xs text-foreground-destructive">
        Cloud agents could not be listed: {String(agents.error)}
      </div>
    );
  if (agents.data && !agent)
    return (
      <div role="alert" className="px-5 pt-3 text-xs text-foreground-destructive">
        This cloud agent is no longer on its Switch server.
      </div>
    );
  return agent?.problem ? <CloudAgentProblem agent={agent} /> : null;
});

function CloudAgentProblem({ agent }: { agent: CloudAgent }) {
  const action = useCloudProblemAction(agent, false);
  return agent.problem ? (
    <div className="px-5 pt-3">
      <CloudProblem
        problem={agent.problem}
        machineReady={cloudMachineReady(agent.machine)}
        compact={false}
        action={action}
      />
    </div>
  ) : null;
}

const CloudSessionPanel = observer(function CloudSessionPanel() {
  const { params } = useParams('cloudSession');
  const agents = useCloudAgents(parseCloudAgentKey(params.agentKey)?.serverId ?? null);
  const agent = useCloudAgentSessions(
    agents.data?.find((each) => each.key === params.agentKey),
    true
  );
  const client = useMemo(
    () => new SessionChatClient(params.sessionId, cloudSessionTransport(params.agentKey)),
    [params.agentKey, params.sessionId]
  );
  const wake = useCloudWake();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <CloudWorkerStatus agentKey={params.agentKey} agent={agent} />
      <SessionV1Chat
        key={`${params.agentKey}:${params.sessionId}`}
        client={client}
        hostState={agent ? cloudAgentState(agent) : null}
        autoWake={{
          phase: agent ? cloudAgentPhase(agent.machine, agent.controller) : null,
          machineReady: agent ? cloudMachineReady(agent.machine) : false,
          blocked: agent ? cloudHoldBlocker(agent) : null,
          wake: () => wake.mutateAsync(params.agentKey),
        }}
        stopHost={() => rpc.sdkHost.stop(params.agentKey, params.sessionId)}
        restartHost={async () => {
          const result = await cloudOperationAttempts.run(
            restartAttemptKey(params.agentKey, params.sessionId),
            params.agentKey,
            'restart',
            params.sessionId
          );
          if (!result) throw new Error('This session is already restarting.');
          if (result.outcome.state === 'unknown')
            throw new Error(
              `${result.outcome.message} Restart again to check: it asks for the same restart, not another.`
            );
          if (result.outcome.state === 'failed') throw new Error(result.outcome.message);
        }}
      />
    </div>
  );
});

export const cloudSessionView = {
  WrapView: ({ children }: CloudSessionParams & { children: ReactNode }) => (
    <SessionHeaderSlotsProvider>{children}</SessionHeaderSlotsProvider>
  ),
  TitlebarSlot: CloudSessionTitlebar,
  MainPanel: CloudSessionPanel,
  canActivate: (params: unknown): GuardResult => {
    const value = (params ?? {}) as Partial<Record<keyof CloudSessionParams, unknown>>;
    if (
      typeof value.agentKey !== 'string' ||
      !parseCloudAgentKey(value.agentKey) ||
      typeof value.sessionId !== 'string' ||
      typeof value.name !== 'string'
    )
      return { ok: false, redirect: 'home', discardParams: true };
    if (!switchCloudFeature.enabled) return { ok: false, redirect: 'home' };
    return { ok: true };
  },
} satisfies ViewDefinition<CloudSessionParams>;
