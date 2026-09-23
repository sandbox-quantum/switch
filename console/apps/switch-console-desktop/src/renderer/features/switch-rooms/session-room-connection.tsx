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
  const roomId =
    query.data?.associations[sessionId] ?? switchRoomsStore.associatedRoomForSession(sessionId);
  const record = query.data?.sessions.find((session) => session.sessionId === sessionId);
  const session = record && 'status' in record ? record : null;
  const detached = !!roomId && !!session?.roomIds && !session.roomIds.includes(roomId);
  const owner = query.data?.sessions.find(
    (other) =>
      'status' in other &&
      other.status !== 'stopped' &&
      !other.retired &&
      other.sessionId !== sessionId &&
      other.agentId === session?.agentId &&
      other.roomIds?.includes(roomId!)
  );
  const mutation = useMutation({
    mutationFn: async (expectedOwner: string | null) => {
      if (!agent?.serverId || !session || !roomId)
        throw new Error('Refresh the room connection before reconnecting.');
      return rpc.sdkHost.reconnectRoom(
        agent.serverId,
        sessionId,
        session.epoch,
        roomId,
        expectedOwner
      );
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
    state === 'connecting' ||
    ((!state || state === 'connected') &&
      (startupStatus === 'starting' ||
        (startupStatus !== 'error' && session?.status === 'starting')));
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
  const online =
    session?.connectivity === 'online' && session.status !== 'stopped' && !session.retired;
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
          {!online && <p>Start this session before reconnecting it to the room.</p>}
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
              disabled={!online || mutation.isPending || query.isError || !state}
              onClick={() => {
                if (owner) setConfirmOwner(owner.sessionId);
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
