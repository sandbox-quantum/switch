import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { PickerCombobox } from '@renderer/lib/components/picker-combobox';
import { RoomPickerRow } from '@renderer/lib/components/room-picker';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Alert, AlertDescription } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { ModalLayout } from '@renderer/lib/ui/modal-layout';

type Props = BaseModalProps<{ roomId: string }> & { workspaceId: string };

/** Picks the room a new template is captured from; the capture page takes it from there. */
export function PickRoomToCaptureModal({ workspaceId, onSuccess, onClose }: Props) {
  const rooms = useQuery({
    queryKey: ['remote-rooms', workspaceId],
    queryFn: () => rpc.workspaces.listRooms(workspaceId),
  });

  return (
    <ModalLayout
      header={
        <DialogHeader showCloseButton>
          <DialogTitle>Create a template from a room</DialogTitle>
        </DialogHeader>
      }
      footer={
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      }
    >
      <DialogContentArea className="gap-3">
        <p className="text-sm text-foreground-muted">
          Pick a room to start from. You choose what becomes a field, and review the template,
          before it is saved.
        </p>
        {rooms.isPending ? (
          <div className="flex justify-center py-4">
            <Loader2 className="size-5 animate-spin text-foreground-muted" />
          </div>
        ) : rooms.isError ? (
          <Alert variant="destructive">
            <AlertDescription>
              {failureText(rooms.error, 'Could not read this workspace’s rooms.')}
            </AlertDescription>
          </Alert>
        ) : (
          <PickerCombobox
            items={rooms.data}
            onPick={(room) => onSuccess({ roomId: room.id })}
            searchText={(room) => room.name}
            renderItem={(room) => <RoomPickerRow room={room} />}
            placeholder="Search rooms…"
            emptyText="No room matches."
          />
        )}
      </DialogContentArea>
    </ModalLayout>
  );
}
