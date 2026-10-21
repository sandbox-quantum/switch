import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Switch } from '@renderer/lib/ui/switch';
import { log } from '@renderer/utils/logger';
import type { AgentSharedSessionChange } from '@shared/core/switch-servers/switch-servers';
import { SettingRow } from './setting-row';

/** The select's value for "no home room": the agent shares no session. */
const NOT_SHARED = '__not_shared__';

/**
 * Per-Switch-agent shared session: one session, based in a home room, that
 * answers every room sharing it instead of each room starting its own. Shown
 * for Switch-linked agents; the settings live on the server, and only the
 * agent's owner or a workspace admin may change them.
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

export function SharedSessionRows({
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
    },
  });

  if (!sharing) return null;
  const prefix = agentName ? `${agentName}: ` : '';
  const live = (rooms ?? []).filter((room) => !room.archived);
  const homeName = live.find((room) => room.roomId === sharing.homeRoomId)?.roomName;

  return (
    <>
      <SettingRow
        title={`${prefix}Shared session`}
        info={{
          label: 'More info about shared sessions',
          content:
            'With a home room, the agent answers every room that shares its session from one session based there, so it carries what it learns between rooms. Rooms that do not share it get a session of their own, as usual.',
        }}
        description="The room the agent's shared session is based in."
        control={
          <Select
            value={sharing.homeRoomId ?? NOT_SHARED}
            disabled={mutation.isPending}
            onValueChange={(next) =>
              mutation.mutate({ homeRoomId: next === NOT_SHARED || !next ? null : next })
            }
          >
            <SelectTrigger className="shrink-0" aria-label="Home room">
              <SelectValue>
                {sharing.homeRoomId ? (homeName ?? 'Home room') : 'Not shared'}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NOT_SHARED}>Not shared</SelectItem>
              {live.map((room) => (
                <SelectItem key={room.roomId} value={room.roomId}>
                  {room.roomName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        {mutation.error && (
          <span className="text-xs text-destructive">
            {failureText(mutation.error, "Could not change this agent's shared session.")}
          </span>
        )}
      </SettingRow>
      {sharing.homeRoomId && (
        <>
          <SettingRow
            title={`${prefix}Share with new rooms`}
            info={null}
            description="Rooms the agent is added to share its session unless whoever adds it chooses otherwise."
            control={
              <Switch
                aria-label="Share with new rooms"
                checked={sharing.sharedByDefault}
                disabled={mutation.isPending}
                onCheckedChange={(checked) => mutation.mutate({ sharedByDefault: checked })}
              />
            }
          />
          <SettingRow
            title={`${prefix}Always shared`}
            info={null}
            description="Every room the agent is in shares its session, and none can be given its own."
            control={
              <Switch
                aria-label="Always shared"
                checked={sharing.locked}
                disabled={mutation.isPending}
                onCheckedChange={(checked) => mutation.mutate({ locked: checked })}
              />
            }
          />
        </>
      )}
    </>
  );
}
