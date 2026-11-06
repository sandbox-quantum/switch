import { useQueryClient } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCloudFilesVisible } from '@renderer/features/cloud-files/use-cloud-files';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import { Progress } from '@renderer/lib/ui/progress';
import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';
import { type MachineAction, machinePresentation } from './cloud-machine-state';
import { hostedSummary } from './hosted-summary';
import { HostedCapacityRows } from './hosted-summary-view';
import { RepairCloud } from './repair-cloud';
import { CLOUD_MACHINES_KEY } from './use-cloud-agents';
import { yourCloudView } from './your-cloud';

const localTime = (at: Date) => at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * The owner's cloud machine: its state, disk, and stop, start and retry. With
 * `box`, it's their own box on the shared cloud instead: shown as "Your cloud",
 * with Your cloud's figures and Repair, and none of a machine's controls, since
 * Switch runs the box (it stops and starts on its own).
 */
export function CloudMachineCard({
  machine,
  serverId,
  box = false,
}: {
  machine: CloudMachine;
  serverId: string;
  box?: boolean;
}) {
  const presented = machinePresentation(machine, Date.now());
  // Switch refuses to start a paused or turned-off cloud, so don't offer it.
  const blocked = machine.stop_reason === 'paused' || machine.stop_reason === 'turned_off';
  const shown = {
    ...presented,
    actions: box ? [] : presented.actions.filter((action) => !(blocked && action === 'start')),
  };
  const cloud = yourCloudView(machine, localTime);
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
  // Your cloud's Start (hosted agents v2). A put-away (retained) or resting box is
  // woken by asking Switch for it (ensure), since lifecycle start can't wake a
  // retained one; a box its owner stopped is started by lifecycle start, since
  // ensure leaves an owner's stop as it is.
  const startBox = async (how: 'ensure' | 'lifecycle') => {
    setPending(true);
    setActionError(null);
    try {
      if (how === 'lifecycle')
        await rpc.switchServers.cloudMachineLifecycle(
          serverId,
          machine.machine_id,
          'start',
          machine.revision
        );
      else await rpc.switchServers.ensureCloudMachine(serverId);
      await queryClient.invalidateQueries({ queryKey: [CLOUD_MACHINES_KEY] });
    } catch (error) {
      setActionError(failureText(error, 'Switch could not start your cloud.'));
      void queryClient.invalidateQueries({ queryKey: [CLOUD_MACHINES_KEY] });
    } finally {
      setPending(false);
    }
  };
  const agentCount = machine.agents.length;
  // Your cloud files (the file explorer): a v2 box only, and only once the flags allow it.
  const filesShown = useCloudFilesVisible(box ? serverId : null);
  return (
    <div className="mb-[14px] rounded-[11px] bg-[var(--surface-2)] p-[14px]">
      <div className="text-sm font-medium">{box ? 'Your cloud' : 'Cloud machine'}</div>
      <div className="text-xs text-foreground-muted">
        {!box && shown.label}
        {!box && machine.instance_type && ` · ${machine.instance_type}`}
        {!box && ' · '}
        {box
          ? hostedSummary(machine).agents
          : `${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}`}
      </div>
      {!box && shown.retainUntil && (
        <p className="mt-2 text-xs">
          Its disk is deleted on {new Date(shown.retainUntil).toLocaleDateString()}. Add a cloud
          agent before then to keep it.
        </p>
      )}
      {/* A v1 machine's disk. A box's disk is in Your cloud's rows below, and only once
          it's the workspace disk, never the controller's own small volume. */}
      {!box && shown.disk && (
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
      {/* Your cloud's figures and Repair (hosted agents v2): only on a v2 box, so a v1
          cloud machine's card stays as upstream. */}
      {!box ? null : cloud.resting ? (
        <div className="mt-2 text-xs text-foreground-muted">
          <span className="font-medium text-foreground">{cloud.heading}</span> · {cloud.line}
          {cloud.start && !blocked && (
            <div className="mt-2">
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => void startBox(cloud.start!)}
              >
                {pending
                  ? cloud.startLabel === 'Wake'
                    ? 'Waking…'
                    : 'Starting…'
                  : (cloud.startLabel ?? 'Start')}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-2 max-w-[360px] space-y-2">
          <p className="text-xs font-medium">{cloud.heading}</p>
          <HostedCapacityRows machine={machine} />
          {cloud.aiCalls && (
            <p
              className={`text-xs ${cloud.aiCalls.capped ? 'text-foreground-warning' : 'text-foreground-muted'}`}
            >
              {cloud.aiCalls.label}
            </p>
          )}
        </div>
      )}
      {box && filesShown && (
        <div className="mt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => appState.navigation.navigate('cloudFiles', { serverId })}
          >
            <FolderOpen className="size-4" />
            Your cloud files
          </Button>
        </div>
      )}
      {box && <RepairCloud machine={machine} serverId={serverId} />}
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
