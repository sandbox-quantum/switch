import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { moveTargets } from './move-targets';
import { MANAGED_AGENTS_KEY, useOwnedMachines } from './use-managed-agents';

/**
 * Moving a managed agent to another of its owner's devices. Switch stops it
 * on the one it is on and starts it on the new one; its files and sessions
 * stay behind, which the dialog says before anything moves. A move Switch
 * refuses (the device went offline, its provider is not ready) is shown in
 * Switch's own words.
 */
export function MoveAgentDialog({
  agent,
  onSuccess,
  onClose,
}: { agent: ManagedAgentView } & BaseModalProps) {
  const machines = useOwnedMachines(agent.serverId);
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useCloseGuard(busy);
  const targets = machines.data ? moveTargets(agent, machines.data) : [];
  const chosen = targets.find((entry) => entry.machineId === target) ?? null;
  const name = agent.displayName ?? agent.name;

  const move = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.managedAgents.update({
        serverId: agent.serverId,
        agentId: agent.agentId,
        changes: { definition: {}, machineId: chosen.machineId },
      });
      await queryClient.invalidateQueries({ queryKey: [MANAGED_AGENTS_KEY] });
      onSuccess(undefined);
    } catch (cause) {
      setError(failureText(cause, `${name} could not be moved. It stays where it is.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader showCloseButton={!busy}>
        <DialogTitle>Move {name} to another device</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0">
        {machines.isPending && (
          <p className="flex items-center gap-2 text-sm">
            <Spinner /> Loading your devices…
          </p>
        )}
        {machines.isError && (
          <p role="alert" className="text-sm text-destructive">
            {failureText(machines.error, 'Your devices could not be listed.')}
          </p>
        )}
        {machines.data && targets.length === 0 && (
          <p className="text-sm text-foreground-muted">
            You have no other device to move it to. Add one in Settings → Your devices.
          </p>
        )}
        {targets.length > 0 && (
          <Select value={target} onValueChange={(value) => setTarget(value)}>
            <SelectTrigger className="w-full" aria-label="Device">
              <SelectValue>{chosen ? chosen.label : 'Choose a device'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {targets.map((entry) => (
                <SelectItem
                  key={entry.machineId}
                  value={entry.machineId}
                  disabled={entry.blocked !== null}
                >
                  <span className="flex-1 truncate">{entry.label}</span>
                  {entry.blocked && (
                    <span className="text-xs text-foreground-muted">{entry.blocked}</span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <p className="text-sm text-foreground-muted">
          {agent.machine
            ? `Switch stops it on ${agent.machine.name} and starts it on the new device.`
            : 'Switch starts it on the new device.'}{' '}
          Files in its working directory and its sessions stay behind. A directory in its old
          device's workspace becomes its workspace on the new one; a directory you chose stays as it
          is, so make sure it exists there.
        </p>
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
        <Button disabled={busy || !chosen || chosen.blocked !== null} onClick={() => void move()}>
          {busy && <Spinner />}
          Move
        </Button>
      </DialogFooter>
    </>
  );
}
