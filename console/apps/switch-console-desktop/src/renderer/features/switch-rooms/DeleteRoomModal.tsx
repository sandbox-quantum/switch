import { TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { type BaseModalProps, useModalContext } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';

type Props = BaseModalProps<void> & {
  serverId: string;
  roomId: string;
  roomName: string;
};

/**
 * Confirm deleting a room.
 *
 * Deleting is not leaving: the room stops existing for everyone in it, and on a
 * bridged room the channel goes with it. Both are things you cannot find out by
 * trying, so they are said before rather than reported after.
 */
export const DeleteRoomModal = observer(function DeleteRoomModal({
  serverId,
  roomId,
  roomName,
  onSuccess,
  onClose,
}: Props) {
  const { setCloseGuard } = useModalContext();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const room = switchRoomsStore.roomSummaryById(roomId);
  const platform = room?.bridgeType ? bridgePlatformLabel(room.bridgeType) : null;
  const agentCount = room?.agentCount ?? 0;

  const handleDelete = useCallback(async () => {
    setIsDeleting(true);
    setCloseGuard(true);
    setError(null);
    try {
      await switchRoomsStore.deleteRoom(serverId, roomId);
      onSuccess();
    } catch (cause) {
      setError(failureText(cause, 'Could not delete the room.'));
      setIsDeleting(false);
    } finally {
      setCloseGuard(false);
    }
  }, [serverId, roomId, onSuccess, setCloseGuard]);

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-red-500" />
          <DialogTitle>Delete “{roomName}”?</DialogTitle>
        </div>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0">
        <p className="text-sm text-foreground-muted">
          This deletes the room for everyone in it, along with its conversation
          {platform ? ` and its ${platform} channel` : ''}. It can’t be undone.
        </p>
        {agentCount > 0 && (
          <p className="text-sm text-foreground-muted">
            {agentCount} {agentCount === 1 ? 'agent leaves' : 'agents leave'} the room. The agents
            themselves are kept.
          </p>
        )}
        {error && <p className="text-destructive text-xs">{error}</p>}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={isDeleting}>
          Cancel
        </Button>
        <ConfirmButton
          variant="destructive"
          onClick={() => void handleDelete()}
          disabled={isDeleting}
        >
          {isDeleting ? 'Deleting…' : 'Delete room'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});
