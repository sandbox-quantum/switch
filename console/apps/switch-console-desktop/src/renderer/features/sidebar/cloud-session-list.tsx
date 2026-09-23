import { sessionSchema, type Session } from '@switch-console/shared/session-v1';
import { useQuery } from '@tanstack/react-query';
import { Cloud, ChevronRight, MessageSquare } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { z } from 'zod';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { useCloudLaunches } from '@renderer/features/switch-servers/use-cloud-launches';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { SidebarMenuButton } from './sidebar-primitives';

export function useCloudSessions() {
  const serverId = switchServersStore.activeServerId;
  const launches = useCloudLaunches(serverId);
  const query = useQuery({
    queryKey: ['cloud-sessions', serverId],
    queryFn: async () => {
      const rows = z
        .array(z.record(z.string(), z.unknown()))
        .parse(await rpc.sdkHost.sharedList(serverId!));
      const owned = new Set(launches.data?.map((launch) => launch.agent_id));
      const sessions: Session[] = [];
      const errors: string[] = [];
      for (const row of rows) {
        if (typeof row.agentId !== 'string' || !owned.has(row.agentId)) continue;
        const parsed = sessionSchema.safeParse(row);
        if (parsed.success) sessions.push(parsed.data);
        else
          errors.push(
            `Cloud session ${typeof row.sessionId === 'string' ? row.sessionId : '(unknown)'} could not be read. Refresh or check server compatibility.`
          );
      }
      return { sessions, errors };
    },
    enabled: !!serverId && !!launches.data?.some((launch) => launch.agent_id),
    refetchInterval: 2000,
    retry: false,
  });
  return {
    serverId,
    launches,
    sessions: { ...query, data: query.data?.sessions },
    discoveryErrors: query.data?.errors ?? [],
  };
}

export const CloudSessionList = observer(function CloudSessionList() {
  const data = useCloudSessions();
  return (
    <>
      <CloudSessionDiscoveryError data={data} />
      <CloudSessionGroups data={data} roomId={null} />
    </>
  );
});

export function CloudSessionDiscoveryError({
  data,
}: {
  data: ReturnType<typeof useCloudSessions>;
}) {
  const error = data.launches.error || data.sessions.error || data.discoveryErrors.join(' ');
  return error ? (
    <div role="alert" className="px-3 py-2 text-xs text-foreground-destructive">
      Cloud session discovery failed: {String(error)}
    </div>
  ) : null;
}

export const CloudSessionGroups = observer(function CloudSessionGroups({
  data,
  roomId,
}: {
  data: ReturnType<typeof useCloudSessions>;
  roomId: string | null;
}) {
  const { serverId, launches, sessions } = data;
  const { navigate } = useNavigate();
  return (
    <>
      {launches.data
        ?.filter(
          (launch) =>
            launch.agent_id &&
            launch.state !== 'deleted' &&
            (roomId
              ? !!sessions.data?.some(
                  (session) =>
                    session.agentId === launch.agent_id &&
                    !session.retired &&
                    session.roomIds?.includes(roomId)
                )
              : (!sidebarStore.filterConnections.size ||
                  sidebarStore.filterConnections.has('remote')) &&
                (!sidebarStore.filterProviderIds.size ||
                  sidebarStore.filterProviderIds.has(launch.provider)) &&
                (!sidebarStore.filterHasLiveSession ||
                  sessions.data?.some(
                    (session) =>
                      session.agentId === launch.agent_id &&
                      session.connectivity === 'online' &&
                      !session.retired
                  )))
        )
        .map((launch) => (
          <div key={launch.request_id} className={roomId ? 'py-1 pl-4' : 'py-1'}>
            <SidebarMenuButton
              onClick={() =>
                sidebarStore.toggleGroupExpanded(`cloud:${roomId ?? 'agent'}:${launch.request_id}`)
              }
              aria-expanded={sidebarStore.isGroupExpanded(
                `cloud:${roomId ?? 'agent'}:${launch.request_id}`
              )}
            >
              <ChevronRight
                className={`size-3 ${sidebarStore.isGroupExpanded(`cloud:${roomId ?? 'agent'}:${launch.request_id}`) ? 'rotate-90' : ''}`}
              />
              <Cloud className="size-3.5" />
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{launch.name}</span>
                {!sidebarStore.hideProviderMark && (
                  <AgentIcon id={launch.provider} size={12} className="h-3 w-3 shrink-0" />
                )}
              </span>
            </SidebarMenuButton>
            {sidebarStore.isGroupExpanded(`cloud:${roomId ?? 'agent'}:${launch.request_id}`) &&
              sessions.data
                ?.filter(
                  (session) =>
                    session.agentId === launch.agent_id &&
                    !session.retired &&
                    (!roomId || session.roomIds?.includes(roomId))
                )
                .map((session) => {
                  const room = session.roomIds?.[0];
                  const name =
                    sidebarStore.cloudSessionNames[`${serverId}:${session.sessionId}`] ??
                    (room ? (switchRoomsStore.roomNameById(room) ?? 'Room session') : 'Session');
                  return (
                    <SidebarMenuButton
                      key={session.sessionId}
                      className="pl-7"
                      onClick={() =>
                        navigate('cloudSession', {
                          serverId: serverId!,
                          requestId: launch.request_id,
                          sessionId: session.sessionId,
                          name: `${launch.name} · ${name}`,
                        })
                      }
                    >
                      <MessageSquare className="size-3.5 shrink-0" />
                      <span className="truncate">{name}</span>
                      <span className="ml-auto text-xs text-foreground-muted">
                        {session.connectivity === 'offline' ? 'Offline' : session.status}
                      </span>
                    </SidebarMenuButton>
                  );
                })}
          </div>
        ))}
    </>
  );
});
