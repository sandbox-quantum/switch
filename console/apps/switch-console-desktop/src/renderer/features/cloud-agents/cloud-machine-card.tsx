import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Progress } from '@renderer/lib/ui/progress';
import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';
import { type MachineAction, machinePresentation } from './cloud-machine-state';
import { CLOUD_MACHINES_KEY } from './use-cloud-agents';

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** The owner's cloud machine: its state, disk, and stop, start and retry. */
export function CloudMachineCard({
  machine,
  serverId,
}: {
  machine: CloudMachine;
  serverId: string;
}) {
  const shown = machinePresentation(machine, Date.now());
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => setActionError(null), [machine.revision, machine.state]);
  const [confirmStop, setConfirmStop] = useState(false);
  const queryClient = useQueryClient();
  const run = async (action: MachineAction) => {
    setPending(true);
    setActionError(null);
    try {
      await rpc.switchServers.cloudMachineLifecycle(
        serverId,
        machine.machine_id,
        action,
        machine.revision
      );
      await queryClient.invalidateQueries({ queryKey: [CLOUD_MACHINES_KEY] });
      setConfirmStop(false);
    } catch (error) {
      setActionError(failureText(error, 'Machine operation failed.'));
      void queryClient.invalidateQueries({ queryKey: [CLOUD_MACHINES_KEY] });
    } finally {
      setPending(false);
    }
  };
  const agentCount = machine.agents.length;
  return (
    <div className="mb-[14px] rounded-[11px] bg-[var(--surface-2)] p-[14px]">
      <div className="text-sm font-medium">Cloud machine</div>
      <div className="text-xs text-foreground-muted">
        {shown.label}
        {machine.instance_type && ` · ${machine.instance_type}`} · {agentCount}{' '}
        {agentCount === 1 ? 'agent' : 'agents'}
      </div>
      {shown.retainUntil && (
        <p className="mt-2 text-xs">
          Its disk is deleted on {new Date(shown.retainUntil).toLocaleDateString()}. Add a cloud
          agent before then to keep it.
        </p>
      )}
      {shown.disk && (
        <div className="mt-2 max-w-[360px]">
          <Progress value={shown.disk.usedPercent} aria-label="Disk used" />
          <p className="mt-1 text-xs text-foreground-muted">
            {gigabytes(shown.disk.availableBytes)} free of {gigabytes(shown.disk.totalBytes)}
          </p>
          {shown.disk.low && (
            <p className="mt-1 text-xs text-foreground-warning">
              Low disk space. The disk cannot grow: remove files or agents you do not need.
            </p>
          )}
        </div>
      )}
      {shown.problem && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {shown.problem}
        </p>
      )}
      {actionError && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {actionError}
        </p>
      )}
      {shown.actions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {shown.actions.includes('start') && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void run('start')}
            >
              Start machine
            </Button>
          )}
          {shown.actions.includes('stop') && !confirmStop && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setConfirmStop(true)}
            >
              Stop machine
            </Button>
          )}
          {shown.actions.includes('retry') && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void run('retry')}
            >
              Retry
            </Button>
          )}
        </div>
      )}
      {confirmStop && shown.actions.includes('stop') && (
        <div className="mt-2 text-xs">
          <p>
            Stop the machine? Every agent on it stops, and mentions will not wake it. Start it again
            here.
          </p>
          <Button size="sm" disabled={pending} onClick={() => void run('stop')}>
            Stop machine
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmStop(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
