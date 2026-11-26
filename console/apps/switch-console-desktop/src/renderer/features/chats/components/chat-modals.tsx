import { useState } from 'react';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@switch-console/chat-ui/primitives/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@switch-console/chat-ui/primitives/dialog';
import { Field, FieldGroup, FieldLabel } from '@switch-console/chat-ui/primitives/field';
import { Input } from '@switch-console/chat-ui/primitives/input';

/** Rename a chat: its room's name, for everyone in it. */
export function RenameChatModal({
  serverId,
  roomId,
  currentName,
  onSuccess,
  onClose,
}: BaseModalProps<string> & { serverId: string; roomId: string; currentName: string }) {
  const [name, setName] = useState(currentName);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed !== currentName;
  const rename = () => {
    if (!valid) return;
    onSuccess(trimmed);
  };
  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Rename chat</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <FieldGroup>
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void rename();
              }}
            />
            <p className="mt-1 text-xs text-foreground-muted">
              The room is renamed for everyone in it.
            </p>
          </Field>
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton onClick={() => void rename()} disabled={!valid}>
          Rename
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
