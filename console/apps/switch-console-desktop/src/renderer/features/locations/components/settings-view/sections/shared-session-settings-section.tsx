import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { SectionLabel } from '@renderer/features/locations/components/main-panel/agent-page-section';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Switch } from '@renderer/lib/ui/switch';
import { log } from '@renderer/utils/logger';
import type { AgentSharedSessionChange } from '@shared/core/switch-servers/switch-servers';
import { HomeRoomPicker } from './home-room-picker';
import { homeRoomOptions } from './home-room-rank';
import { SettingRow } from './setting-row';

/**
 * Per-Switch-agent shared session: one session, based in a home room, that
 * answers every room sharing it instead of each room starting its own. Shown
 * for Switch-linked agents as a section of its own; the settings live on the
 * server, and only the agent's owner or a workspace admin may change them.
 */
export function SharedSessionSettingsSection({
  locationId,
  agentId,
}: {
  locationId: string;
  /** Scope to a single agent; omit to show every Switch-linked agent. */
  agentId?: string;
}) {
  const { data: agents } = useQuery({
    queryKey: ['location-agents', locationId],
    queryFn: () => rpc.agents.getAgents(locationId),
  });

  const switchAgents = (agents ?? []).filter(
    (a) => a.workspaceId && a.switchAgentId && (!agentId || a.id === agentId)
  );
  if (switchAgents.length === 0) return null;

  return (
    <>
      {switchAgents.map((agent) => (
        <SharedSessionRows
          key={agent.id}
          workspaceId={agent.workspaceId as string}
          agentId={agent.switchAgentId as string}
          agentName={switchAgents.length > 1 ? agent.name : null}
        />
      ))}
    </>
  );
}

/** Query key for an agent's shared session, invalidated by the rooms list too. */
export const sharedSessionKey = (workspaceId: string, agentId: string) => [
  'agent-shared-session',
  workspaceId,
  agentId,
];

export const SharedSessionRows = observer(function SharedSessionRows({
  workspaceId,
  agentId,
  agentName,
}: {
  workspaceId: string;
  agentId: string;
  /** Shown when the location has several Switch agents; null for one. */
  agentName: string | null;
}) {
  const queryClient = useQueryClient();
  const key = sharedSessionKey(workspaceId, agentId);
  const { data: sharing } = useQuery({
    queryKey: key,
    queryFn: () => rpc.workspaces.getSharedSession({ workspaceId, agentId }),
  });
  const { data: rooms } = useQuery({
    queryKey: ['agent-rooms', workspaceId, agentId],
    queryFn: () => rpc.workspaces.listAgentRooms({ workspaceId, agentId }),
  });
  const mutation = useMutation({
    mutationFn: (change: AgentSharedSessionChange) =>
      rpc.workspaces.updateSharedSession({ workspaceId, agentId, change }),
    onError: (error) => log.error('Failed to update the shared session', { agentId, error }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: ['agent-rooms', workspaceId, agentId] });
      void switchRoomsStore.fetchAgentRooms(workspaceId, agentId, { force: true });
    },
  });

  if (!sharing) return null;
  const { suggested, all } = homeRoomOptions(rooms ?? [], (roomId) =>
    switchRoomsStore.roomSummaryById(roomId)
  );
  const off = !sharing.homeRoomId;

  return (
    <section className="flex flex-col gap-3" aria-label="Shared session">
      <SectionLabel>{agentName ? `${agentName}: shared session` : 'Shared session'}</SectionLabel>
      <p className="text-sm text-foreground-muted">
        Answer several rooms from one session, based in a home room, so the agent carries what it
        learns from room to room. Rooms that don't share it get a session of their own, as usual.
      </p>
      <fieldset className="flex flex-col gap-6 rounded-lg border border-border p-4">
        <legend className="sr-only">Shared session settings</legend>
        <SettingRow
          title="Home room"
          info={null}
          description="Where the shared session is based. Pick one to start sharing."
          control={
            <HomeRoomPicker
              value={sharing.homeRoomId}
              suggested={suggested}
              all={all}
              disabled={mutation.isPending}
              onChange={(homeRoomId) => mutation.mutate({ homeRoomId })}
            />
          }
        >
          {mutation.error && (
            <span className="text-xs text-destructive">
              {failureText(mutation.error, "Could not change this agent's shared session.")}
            </span>
          )}
        </SettingRow>
        <SettingRow
          title="Share with new rooms"
          info={null}
          description="Rooms the agent is added to share its session, unless whoever adds it chooses otherwise."
          control={
            <Switch
              aria-label="Share with new rooms"
              checked={sharing.sharedByDefault}
              disabled={off || mutation.isPending}
              onCheckedChange={(checked) => mutation.mutate({ sharedByDefault: checked })}
            />
          }
        />
        <SettingRow
          title="Always shared"
          info={null}
          description="Every room the agent is in shares its session, and none can be given its own."
          control={
            <Switch
              aria-label="Always shared"
              checked={sharing.locked}
              disabled={off || mutation.isPending}
              onCheckedChange={(checked) => mutation.mutate({ locked: checked })}
            />
          }
        />
      </fieldset>
    </section>
  );
});
