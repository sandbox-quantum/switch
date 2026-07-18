import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';

export type DeleteSessionModalArgs = {
  locationId: string;
  sessions: Array<{ sessionId: string; sessionName: string }>;
};

type Props = BaseModalProps<void> & DeleteSessionModalArgs;

export function DeleteSessionModal({ sessions, onSuccess, onClose }: Props) {
  const count = sessions.length;
  const isBulk = count > 1;

  const title = isBulk ? `Delete ${count} sessions` : 'Delete session';

  const description = isBulk
    ? `${count} sessions will be permanently deleted. This action cannot be undone.`
    : `"${sessions[0]!.sessionName}" will be permanently deleted. This action cannot be undone.`;

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="flex flex-col gap-4 pt-0">
        <p className="text-sm text-foreground-muted">{description}</p>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton variant="destructive" onClick={() => onSuccess()}>
          {isBulk ? `Delete ${count} sessions` : 'Delete'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
