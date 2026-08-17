import { observer } from 'mobx-react-lite';
import { useCallback, useState } from 'react';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
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
import { switchServersStore } from './switch-servers-store';

type RenameServerModalArgs = {
  serverId: string;
  currentName: string;
};

type Props = BaseModalProps<void> & RenameServerModalArgs;

export const RenameServerModal = observer(function RenameServerModal({
  serverId,
  currentName,
  onSuccess,
  onClose,
}: Props) {
  const [name, setName] = useState(currentName);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const isEmpty = trimmed.length === 0;
  const isUnchanged = trimmed === currentName.trim();
  const isValid = !isEmpty && !isUnchanged;

  const handleSubmit = useCallback(async () => {
    if (!isValid) return;
    setIsSubmitting(true);
    setError(null);
    const ok = await switchServersStore.renameServer(serverId, trimmed);
    if (ok) {
      onSuccess();
    } else {
      setError(switchServersStore.errorText ?? 'Could not rename the server.');
      setIsSubmitting(false);
    }
  }, [isValid, serverId, trimmed, onSuccess]);

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Rename server</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <FieldGroup>
          <Field>
            <FieldLabel>Server name</FieldLabel>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSubmit();
              }}
              autoFocus
            />
            {isEmpty && !isUnchanged && (
              <p className="text-destructive mt-1 text-xs">Server name cannot be empty.</p>
            )}
            {error && <p className="text-destructive mt-1 text-xs">{error}</p>}
          </Field>
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton onClick={() => void handleSubmit()} disabled={!isValid || isSubmitting}>
          {isSubmitting ? 'Renaming…' : 'Rename'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});
