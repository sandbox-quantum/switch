import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
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
import { Textarea } from '@renderer/lib/ui/textarea';
import {
  MAX_MACHINE_DESCRIPTION,
  MAX_MACHINE_NAME,
} from '@shared/core/managed-agents/machine-enrollment';

type Props = BaseModalProps<void> & {
  serverId: string;
  machineId: string;
  currentName: string;
  currentDescription: string | null;
};

/** Renames one of the person's machines and changes its description; an empty description clears it. */
export function RenameMachineModal({
  serverId,
  machineId,
  currentName,
  currentDescription,
  onSuccess,
  onClose,
}: Props) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(currentName);
  const [description, setDescription] = useState(currentDescription ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const nameChanged = trimmedName !== currentName;
  const descriptionChanged = trimmedDescription !== (currentDescription ?? '');
  const nameTooLong = trimmedName.length > MAX_MACHINE_NAME;
  const descriptionTooLong = trimmedDescription.length > MAX_MACHINE_DESCRIPTION;
  const valid =
    trimmedName.length > 0 &&
    !nameTooLong &&
    !descriptionTooLong &&
    (nameChanged || descriptionChanged);

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await rpc.managedAgents.updateMachine({
        serverId,
        machineId,
        changes: {
          ...(nameChanged ? { name: trimmedName } : {}),
          ...(descriptionChanged ? { description: trimmedDescription || null } : {}),
        },
      });
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY, serverId] });
      onSuccess();
    } catch (err) {
      setError(failureText(err, 'Could not save the machine.'));
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Rename machine</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <FieldGroup>
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
              }}
              autoFocus
            />
            {trimmedName.length === 0 && (
              <p className="mt-1 text-xs text-destructive">A machine needs a name.</p>
            )}
            {nameTooLong && (
              <p className="mt-1 text-xs text-destructive">
                At most {MAX_MACHINE_NAME} characters.
              </p>
            )}
          </Field>
          <Field>
            <FieldLabel>Description (optional)</FieldLabel>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this machine is for"
              rows={3}
            />
            {descriptionTooLong && (
              <p className="mt-1 text-xs text-destructive">
                At most {MAX_MACHINE_DESCRIPTION} characters.
              </p>
            )}
          </Field>
        </FieldGroup>
        {error && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton onClick={() => void save()} disabled={!valid || saving}>
          {saving ? 'Saving…' : 'Save'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
