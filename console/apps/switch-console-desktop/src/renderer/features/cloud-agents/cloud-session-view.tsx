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
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { parseCloudAgentKey } from '@shared/core/cloud-agents/cloud-agents';
import { CloudProblem } from './cloud-problem';
import { useCloudAgents } from './use-cloud-agents';

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

/** The launch's state over the transcript while its worker cannot be asked. */
const CloudWorkerStatus = observer(function CloudWorkerStatus({ agentKey }: { agentKey: string }) {
  const agents = useCloudAgents(parseCloudAgentKey(agentKey)?.serverId ?? null);
  const agent = agents.data?.find((each) => each.key === agentKey);
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
  return agent?.problem ? (
    <div className="px-5 pt-3">
      <CloudProblem
        agentKey={agentKey}
        launch={agent.launch}
        problem={agent.problem}
        compact={false}
      />
    </div>
  ) : null;
});

function CloudSessionPanel() {
  const { params } = useParams('cloudSession');
  const client = useMemo(
    () => new SessionChatClient(params.sessionId, cloudSessionTransport(params.agentKey)),
    [params.agentKey, params.sessionId]
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <CloudWorkerStatus agentKey={params.agentKey} />
      <SessionV1Chat
        key={`${params.agentKey}:${params.sessionId}`}
        client={client}
        stopHost={() => rpc.sdkHost.stop(params.agentKey, params.sessionId)}
        restartHost={async () => {
          await rpc.sdkHost.cloudSessionOperation(params.agentKey, params.sessionId, 'restart');
        }}
      />
    </div>
  );
}

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
    return { ok: true };
  },
} satisfies ViewDefinition<CloudSessionParams>;
