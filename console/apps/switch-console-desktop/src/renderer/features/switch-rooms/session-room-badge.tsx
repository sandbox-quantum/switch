import { Radio } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { switchRoomsStore } from './switch-rooms-store';

/**
 * Small indicator shown on a session when its agent is connected to a Switch
 * room. Renders nothing when the session is not connected to any room.
 */
export const SessionRoomBadge = observer(function SessionRoomBadge({
  sessionId,
}: {
  sessionId: string;
}) {
  useEffect(() => {
    switchRoomsStore.ensureLoaded();
  }, []);

  const roomId = switchRoomsStore.roomForSession(sessionId);
  if (!roomId) return null;

  return (
    <Tooltip>
      <TooltipTrigger>
        <span className="flex shrink-0 items-center text-foreground-passive">
          <Radio className="h-3.5 w-3.5" aria-label="Connected to a Switch room" />
        </span>
      </TooltipTrigger>
      <TooltipContent>Connected to Switch room {roomId}</TooltipContent>
    </Tooltip>
  );
});
