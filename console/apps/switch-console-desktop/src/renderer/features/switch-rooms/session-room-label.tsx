import { Hash } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { switchRoomsStore as serverRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { switchRoomsStore } from './switch-rooms-store';

/**
 * Which Switch room a session is talking in, as the session lists show it.
 *
 * Three answers, deliberately not collapsed into two: the room's name, "No
 * room", and nothing at all. The last covers a failed connection seed or a room
 * list that has not been read — a session whose room could not be looked up
 * must not be reported as being in none, since "no room" is the state someone
 * would go and fix.
 */
export const SessionRoomLabel = observer(function SessionRoomLabel({
  sessionId,
}: {
  sessionId: string;
}) {
  useEffect(() => {
    switchRoomsStore.ensureLoaded();
  }, []);

  if (switchRoomsStore.seedError) return null;

  const roomId = switchRoomsStore.roomForSession(sessionId);
  if (!roomId) {
    return <span className="shrink-0 text-xs text-foreground-passive">No room</span>;
  }

  const name = serverRoomsStore.roomNameById(roomId);
  if (!name) return null;

  // The platform the room lives on, marked the way the rest of the app marks it.
  // A room name on its own says which conversation; the icon says where it is
  // happening, which is what tells two similarly-named rooms apart.
  const bridgeType = serverRoomsStore.roomBridgeTypeById(roomId);

  return (
    <span className="flex max-w-40 shrink-0 items-center gap-1.5 text-xs text-foreground-muted">
      {hasBridgeIcon(bridgeType) ? (
        <BridgeIcon bridgeType={bridgeType} size={12} />
      ) : (
        <Hash className="size-3 shrink-0" />
      )}
      <span className="truncate">{name}</span>
    </span>
  );
});
