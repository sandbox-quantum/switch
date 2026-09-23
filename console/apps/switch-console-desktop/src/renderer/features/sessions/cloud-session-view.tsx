import { SessionChatClient } from '@switch-console/shared/session-v1';
import { Cloud } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import type { GuardResult, ViewDefinition } from '@renderer/app/view-registry';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { rpc } from '@renderer/lib/ipc';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { runCloudSessionOperation } from './cloud-session-operation';
import { SessionV1Chat } from './components/transcript/session-v1-chat';
import { sharedSessionTransport } from './components/transcript/shared-session-transport';
import { SessionHeaderOutlet, SessionHeaderSlotsProvider } from './session-header-slots';

type CloudSessionParams = { serverId: string; sessionId: string; requestId: string; name: string };

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

function CloudSessionPanel() {
  const { params } = useParams('cloudSession');
  const client = useMemo(
    () => new SessionChatClient(params.sessionId, sharedSessionTransport(params.serverId)),
    [params.serverId, params.sessionId]
  );
  return (
    <SessionV1Chat
      key={`${params.serverId}:${params.sessionId}`}
      client={client}
      restartHost={() =>
        runCloudSessionOperation(params.serverId, params.requestId, params.sessionId, 'restart')
      }
      stopHost={() => rpc.sdkHost.stop(params.serverId, params.sessionId)}
      retireHost={async (epoch) => {
        await rpc.sdkHost.retire(params.serverId, params.sessionId, epoch);
      }}
    />
  );
}

export const cloudSessionView = {
  WrapView: ({ children }: CloudSessionParams & { children: ReactNode }) => (
    <SessionHeaderSlotsProvider>{children}</SessionHeaderSlotsProvider>
  ),
  TitlebarSlot: CloudSessionTitlebar,
  MainPanel: CloudSessionPanel,
  canActivate: (params: unknown): GuardResult => {
    if (
      !params ||
      typeof params !== 'object' ||
      !('serverId' in params) ||
      typeof params.serverId !== 'string' ||
      !('sessionId' in params) ||
      typeof params.sessionId !== 'string' ||
      !('requestId' in params) ||
      typeof params.requestId !== 'string' ||
      !('name' in params) ||
      typeof params.name !== 'string'
    )
      return { ok: false, redirect: 'home' };
    return { ok: true as const };
  },
} satisfies ViewDefinition<CloudSessionParams>;
