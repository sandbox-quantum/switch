import { Button } from '@switch-console/chat-ui/primitives/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@switch-console/chat-ui/primitives/dialog';
import type { ReactNode } from 'react';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';

export type ConfirmActionDialogArgs = {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'destructive' | 'default';
};

type Props = BaseModalProps<void> & ConfirmActionDialogArgs;

export function ConfirmActionDialog({
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'destructive',
  onSuccess,
  onClose,
}: Props) {
  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        {typeof description === 'string' ? <p>{description}</p> : description}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {cancelLabel}
        </Button>
        <ConfirmButton variant={variant} onClick={() => onSuccess()}>
          {confirmLabel}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
