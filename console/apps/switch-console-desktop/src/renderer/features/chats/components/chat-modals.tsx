import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { chatsStore } from '../stores/chats';

/** Rename a chat: its room's name, for everyone in it. */
export function RenameChatModal({
  serverId,
  roomId,
  currentName,
  onSuccess,
  onClose,
}: BaseModalProps<void> & { serverId: string; roomId: string; currentName: string }) {
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed !== currentName;
  const rename = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.chats.rename(serverId, roomId, trimmed);
      const chat = chatsStore.chat(roomId);
      if (chat) chatsStore.add(serverId, { ...chat, name: trimmed });
      onSuccess();
    } catch (caught) {
      setError(failureText(caught, 'Could not rename the chat.'));
      setBusy(false);
    }
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
            {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
          </Field>
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton onClick={() => void rename()} disabled={!valid || busy}>
          {busy ? 'Renaming…' : 'Rename'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
