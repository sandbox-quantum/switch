import { type ReactNode, useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogContentArea,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';

/**
 * Ask before archiving a room: it leaves everyone's room lists, not just
 * yours, so it is worth a second look. Unarchiving puts it back and asks
 * nothing.
 */
export function useArchiveRoomConfirm(): {
  request: (roomName: string, archive: () => void) => void;
  dialog: ReactNode;
} {
  // Kept while the dialog animates closed, so its wording does not empty on the way out.
  const [pending, setPending] = useState<{ roomName: string; archive: () => void } | null>(null);
  const [open, setOpen] = useState(false);

  const request = (roomName: string, archive: () => void) => {
    setPending({ roomName, archive });
    setOpen(true);
  };

  const dialog = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive {pending?.roomName ?? 'this room'}?</DialogTitle>
        </DialogHeader>
        <DialogContentArea>
          <DialogDescription>
            It drops out of the room lists, yours and everyone else’s, until someone unarchives it.
            Who is in it, its history and its channel stay as they are.
          </DialogDescription>
        </DialogContentArea>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button
            size="sm"
            onClick={() => {
              setOpen(false);
              pending?.archive();
            }}
          >
            Archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { request, dialog };
}
