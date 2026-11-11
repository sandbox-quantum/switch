import { useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Switch } from '@renderer/lib/ui/switch';
import type { DecisionRoomDefault } from '@shared/core/switch-servers/switch-servers';

const EXPLANATION =
  'New rooms start with auto-route on, including platform channels Switch picks up and group chats. Existing rooms and direct chats aren’t changed, and any room can turn it off.';

/**
 * The workspace's auto-route default for new rooms, beside its decision
 * routing. Held off while no decision service is available, since a room made
 * then could not route anyway; a stored "on" waits and applies once one is.
 * `decisionsAvailable` is the decision settings' own answer, so a save there
 * re-reads this one.
 */
export function AutoRouteNewRooms({
  workspaceId,
  decisionsAvailable,
}: {
  workspaceId: string;
  decisionsAvailable: boolean;
}) {
  const [roomDefault, setRoomDefault] = useState<DecisionRoomDefault | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    rpc.switchServers.getDecisionRoomDefault(workspaceId).then(
      (result) => {
        if (cancelled) return;
        if (result.kind === 'loaded') {
          setRoomDefault(result.roomDefault);
          setError(null);
        } else if (result.kind === 'unsupported' || result.kind === 'forbidden') {
          setHidden(true);
        } else {
          setError(
            result.kind === 'unauthenticated'
              ? 'Your session has expired. Sign in again.'
              : result.message
          );
        }
      },
      (cause: unknown) => {
        if (!cancelled) setError(failureText(cause, 'Could not load the default for new rooms.'));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, decisionsAvailable]);

  if (hidden) return null;
  if (roomDefault === null && error === null) return null;

  const change = async (on: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.switchServers.updateDecisionRoomDefault({
        workspaceId,
        autoRouteNewRooms: on,
      });
      if (result.kind === 'saved') setRoomDefault(result.roomDefault);
      else if (result.kind === 'unauthenticated')
        setError('Your session has expired. Sign in again.');
      else if (result.kind === 'forbidden')
        setError('Only an admin of this workspace can change this.');
      else setError(result.message);
    } catch (cause) {
      setError(failureText(cause, 'Could not save the default for new rooms.'));
    } finally {
      setSaving(false);
    }
  };

  const available = roomDefault?.available ?? false;
  return (
    <div className="flex flex-col gap-1.5 border-t border-border-1 pt-4" aria-label="New rooms">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">Auto-route new rooms</span>
        <Switch
          aria-label="Auto-route new rooms"
          checked={roomDefault?.autoRouteNewRooms ?? false}
          disabled={roomDefault === null || !available || saving}
          onCheckedChange={(on) => void change(on)}
        />
      </div>
      <p className="text-xs text-foreground-muted">{EXPLANATION}</p>
      {roomDefault !== null && !available && (
        <p className="text-xs text-foreground-muted">
          Choose a decision service first.
          {roomDefault.autoRouteNewRooms ? ' It’s saved as on, and applies once one is.' : ''}
        </p>
      )}
      {error !== null && <p className="text-xs text-destructive">Not saved — {error}</p>}
    </div>
  );
}
