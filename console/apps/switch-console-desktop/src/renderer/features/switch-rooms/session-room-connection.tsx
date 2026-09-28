import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Unplug } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import { connectionLabels } from '@shared/core/switch-rooms/connection-health';
import { useAgentConnection, roomHealthKey } from './connection-health';
import { switchRoomsStore } from './switch-rooms-store';

export const SessionRoomConnection = observer(function SessionRoomConnection({
  sessionId,
  agentId,
  compact = false,
  startupStatus,
}: {
  sessionId: string;
  agentId: string;
  compact?: boolean;
  startupStatus?: 'starting' | 'ready' | 'error';
}) {
  const agent = agentsStore.agentById(agentId);
  const { query, state } = useAgentConnection(agent);
  const { navigate } = useNavigate();
  const cache = useQueryClient();
  const [confirmOwner, setConfirmOwner] = useState<string | null | undefined>(undefined);
  const placements = query.data?.placements ?? {};
  const roomId = switchRoomsStore.associatedRoomForSession(sessionId) ?? placements[sessionId];
  // Another of the agent's sessions has taken this room, so its messages go
  // there. A session nobody has displaced is not detached, whether or not it
  // ever connected itself: its room's messages still come to it.
  const owner = roomId
    ? Object.entries(placements).find(
        ([other, room]) => other !== sessionId && room === roomId
      )?.[0]
    : undefined;
  const detached = !!owner && placements[sessionId] !== roomId;
  const mutation = useMutation({
    mutationFn: async (_expectedOwner: string | null) => {
      if (!roomId) throw new Error('Refresh the room connection before reconnecting.');
      return rpc.sdkHost.placeSession(agentId, sessionId, roomId);
    },
    retry: false,
    onSettled: async () => {
      setConfirmOwner(undefined);
      await cache.invalidateQueries({ queryKey: roomHealthKey(agent?.serverId ?? null) });
    },
  });
  useEffect(() => {
    if (startupStatus === 'ready' && agent?.serverId) {
      void cache.invalidateQueries({ queryKey: roomHealthKey(agent.serverId) });
    }
  }, [startupStatus, agent?.serverId, cache]);
  if (!agent || !roomId) return null;
  const settling =
    state === 'connecting' || ((!state || state === 'connected') && startupStatus === 'starting');
  if (settling && !mutation.isError) {
    if (compact) return null;
    return (
      <div
        role="status"
        className="mx-5 my-2 flex shrink-0 items-center gap-2 text-sm text-foreground-muted"
      >
        <Loader2 className="size-4 animate-spin" />
        {state === 'connecting'
          ? 'Establishing room connection…'
          : 'Waiting for session connection…'}
      </div>
    );
  }
  const unavailable = !!state && state !== 'connected';
  if (!detached && !unavailable && !mutation.isError) return null;
  const label = detached
    ? 'Disconnected from room messages'
    : state
      ? connectionLabels[state]
      : 'Could not check room connection';
  // Watcher failure is already marked on the agent heading. The session mark
  // is only for a known ownership mismatch, not for missing health evidence.
  if (compact)
    return detached ? (
      <span title={label} aria-label={label}>
        <Unplug className="size-3.5 text-foreground-warning" />
      </span>
    ) : null;
  const manage = () =>
    navigate('location', { locationId: agent.locationId, agentName: agent.name });
  return (
    <div
      role="status"
      className="mx-5 my-2 flex flex-col gap-2 rounded-md border border-border p-3 text-sm"
    >
      <div className="flex items-center gap-2 text-foreground-warning">
        <AlertTriangle className="size-4 shrink-0" />
        {label}
      </div>
      {unavailable ? (
        <>
          <p>
            This agent's room connection needs attention before this conversation can receive room
            messages.
          </p>
          <Button variant="outline" size="sm" className="self-start" onClick={manage}>
            Open room watcher
          </Button>
        </>
      ) : detached ? (
        <>
          <p>This conversation is saved here, but it is not receiving this room's messages.</p>
          {confirmOwner !== undefined ? (
            <>
              <p>
                Another session receives this agent's messages in this room. Reconnecting will move
                delivery here. Both conversations and work already running will be preserved.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate(confirmOwner)}
                >
                  Confirm reconnect
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={mutation.isPending}
                  onClick={() => setConfirmOwner(undefined)}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              disabled={mutation.isPending || query.isError || !state}
              onClick={() => {
                if (owner) setConfirmOwner(owner);
                else mutation.mutate(null);
              }}
            >
              {mutation.isPending ? 'Reconnecting…' : 'Reconnect to room'}
            </Button>
          )}
        </>
      ) : null}
      {mutation.isError && (
        <p role="alert" className="text-foreground-destructive">
          Reconnect was not confirmed: {String(mutation.error)}. Check the current state before
          trying again.
        </p>
      )}
    </div>
  );
});
