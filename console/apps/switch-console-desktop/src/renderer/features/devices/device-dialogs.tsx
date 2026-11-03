import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { useCloseGuard } from '@renderer/lib/modal/use-close-guard';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Input } from '@renderer/lib/ui/input';
import { Spinner } from '@renderer/lib/ui/spinner';
import {
  MAX_MACHINE_DESCRIPTION,
  MAX_MACHINE_NAME,
} from '@shared/core/embedded-controller/embedded-controller';
import type { DeviceDetail } from '@shared/core/managed-agents/managed-agents';

/** Renaming a device and changing what it is for, as Switch names it everywhere, rooms included. */
export function EditDeviceDialog({
  serverId,
  device,
  onSuccess,
  onClose,
}: {
  serverId: string;
  device: Pick<DeviceDetail, 'id' | 'name' | 'description'>;
} & BaseModalProps) {
  const [name, setName] = useState(device.name);
  const [description, setDescription] = useState(device.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  useCloseGuard(busy);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await rpc.managedAgents.updateDevice({
        serverId,
        machineId: device.id,
        changes: { name: name.trim(), description: description.trim() || null },
      });
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY] });
      onSuccess(undefined);
    } catch (cause) {
      setError(failureText(cause, 'The device could not be changed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader showCloseButton={!busy}>
        <DialogTitle>Edit {device.name}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0">
        <Input
          aria-label="Name"
          value={name}
          maxLength={MAX_MACHINE_NAME}
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          aria-label="Description"
          placeholder="What it is for (optional)"
          value={description}
          maxLength={MAX_MACHINE_DESCRIPTION}
          onChange={(event) => setDescription(event.target.value)}
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy || !name.trim()} onClick={() => void save()}>
          {busy && <Spinner />}
          Save
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Removing a device: Switch revokes its controller, which stops. Its agents
 * stay placed on it, and so run nowhere, until they are moved; the dialog
 * names them first.
 */
export function RemoveDeviceDialog({
  serverId,
  device,
  agentNames,
  onSuccess,
  onClose,
}: {
  serverId: string;
  device: Pick<DeviceDetail, 'id' | 'name'>;
  agentNames: string[];
} & BaseModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  useCloseGuard(busy);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await rpc.managedAgents.removeDevice({ serverId, machineId: device.id });
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY] });
      onSuccess(undefined);
    } catch (cause) {
      setError(failureText(cause, `${device.name} could not be removed.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader showCloseButton={!busy}>
        <DialogTitle>Remove {device.name}?</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0 text-sm">
        <p>
          Switch revokes its agent controller, which stops running agents. To use it again, add it
          as a new device.
        </p>
        {agentNames.length > 0 && (
          <p>
            {agentNames.join(', ')} {agentNames.length === 1 ? 'is' : 'are'} placed on it and will
            run nowhere until moved to another device.
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
          {busy && <Spinner />}
          Remove
        </Button>
      </DialogFooter>
    </>
  );
}
