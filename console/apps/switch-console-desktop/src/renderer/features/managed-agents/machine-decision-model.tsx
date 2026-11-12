import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  MACHINE_POLL_MS,
  machineOption,
  machineSettling,
  machineStateLine,
} from '@renderer/features/admin/decision-routing';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';

export const decisionSettingsQueryKey = (workspaceId: string) => ['decision-settings', workspaceId];

type Pending = 'stop' | 'remove';

const CONFIRM: Record<Pending, { question: string; action: string }> = {
  stop: {
    question:
      'Stop running the decision model here? Auto-route in this workspace goes back to the server default. The downloaded model stays for next time.',
    action: 'Stop',
  },
  remove: {
    question:
      'Stop running the decision model here and remove the downloaded model from this computer? It is downloaded again if this computer is chosen later.',
    action: 'Remove',
  },
};

/**
 * On a machine's card, whether it runs auto-route's decision model for the
 * workspace, and where that stands, with Stop (the workspace back to the
 * server default) and, on this computer, "Remove downloaded model".
 *
 * Read from the workspace's decision settings, which only its admins can
 * read: for anyone else, and for a machine the workspace doesn't use, it
 * shows nothing.
 */
export function MachineDecisionModel({
  workspaceId,
  serverId,
  machineId,
  thisComputer,
}: {
  workspaceId: string;
  serverId: string;
  machineId: string;
  thisComputer: boolean;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<Pending | null>(null);
  /** How the last Stop or Remove went, kept in view after the workspace stops using the machine. */
  const [outcome, setOutcome] = useState<{ text: string; failed: boolean } | null>(null);
  const query = useQuery({
    queryKey: decisionSettingsQueryKey(workspaceId),
    queryFn: () => rpc.switchServers.getDecisionSettings(workspaceId),
    refetchInterval: (current) => {
      const data = current.state.data;
      return data?.kind === 'loaded' && machineSettling(data.settings) ? MACHINE_POLL_MS : false;
    },
  });
  const settings = query.data?.kind === 'loaded' ? query.data.settings : null;
  const machine = settings?.effective.machine ?? null;
  const chosen =
    settings !== null && settings.effective.backend === 'machine' && machine?.id === machineId;
  if (!chosen && busy === null && outcome === null) return null;

  const run = async (what: Pending) => {
    setConfirming(null);
    setBusy(what);
    setOutcome(null);
    try {
      const cleared = await rpc.switchServers.clearDecisionSettings(workspaceId);
      if (cleared.kind !== 'cleared') {
        setOutcome({
          failed: true,
          text:
            cleared.kind === 'forbidden'
              ? 'Only an admin of this workspace can change its decision routing.'
              : cleared.kind === 'unauthenticated'
                ? 'Your session has expired. Sign in again.'
                : cleared.message,
        });
        return;
      }
      queryClient.setQueryData(decisionSettingsQueryKey(workspaceId), {
        kind: 'loaded',
        settings: cleared.settings,
      });
      if (what === 'remove') {
        await rpc.embeddedController.removeDecisionModel(serverId);
        setOutcome({ failed: false, text: 'Stopped, and removed the downloaded model.' });
      } else {
        setOutcome({
          failed: false,
          text: 'Stopped. Auto-route uses the server default; the downloaded model stays.',
        });
      }
    } catch (cause) {
      setOutcome({
        failed: true,
        text: failureText(
          cause,
          what === 'remove'
            ? 'Could not remove the downloaded model.'
            : 'Could not stop the decision model.'
        ),
      });
    } finally {
      setBusy(null);
      void queryClient.invalidateQueries({ queryKey: decisionSettingsQueryKey(workspaceId) });
    }
  };

  const line =
    chosen && settings !== null && machine !== null
      ? machineStateLine(machine, machineOption(settings, machine.id))
      : null;
  return (
    <div className="flex flex-col gap-2 text-sm" aria-label="Decision model">
      {line !== null && (
        <p role="status">
          {machine?.state === 'running' && line.tone === 'ok'
            ? 'Decision model: running for auto-route'
            : `Decision model for auto-route: ${line.text}`}
        </p>
      )}
      {line !== null && confirming !== null && (
        <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
          <p className="text-xs text-foreground-muted">{CONFIRM[confirming].question}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" onClick={() => void run(confirming)}>
              {CONFIRM[confirming].action}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {(line !== null || busy !== null) && confirming === null && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => setConfirming('stop')}
          >
            {busy === 'stop' ? 'Stopping…' : 'Stop'}
          </Button>
          {thisComputer && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirming('remove')}
            >
              {busy === 'remove' ? 'Removing…' : 'Remove downloaded model'}
            </Button>
          )}
        </div>
      )}
      {outcome !== null && (
        <p
          aria-label="Decision model outcome"
          className={outcome.failed ? 'text-xs text-destructive' : 'text-xs text-foreground-muted'}
        >
          {outcome.text}
        </p>
      )}
    </div>
  );
}
