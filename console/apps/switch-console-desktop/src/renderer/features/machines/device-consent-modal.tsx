import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import type { DeviceConsentAsk } from '@shared/core/embedded-controller/embedded-controller';
import { serverForConsent } from './turn-on-machine';

/** What an ask would let the agent do, as the person reads it. */
export function askLines(ask: Pick<DeviceConsentAsk, 'bypass' | 'directory'>): string[] {
  return [
    ...(ask.bypass
      ? ['Run every command without asking you first, as you, on this computer.']
      : []),
    ...(ask.directory !== null ? [`Work in ${ask.directory} on this computer.`] : []),
  ];
}

type Props = BaseModalProps<void> & { serverId: string; ask: DeviceConsentAsk };

/**
 * A managed agent asks this computer for more than its server can grant:
 * running without approvals, or a folder outside its workspaces. The person
 * here allows it or not; until they allow it, the controller keeps the agent
 * asking before it acts, or does not start it in that folder.
 */
export const DeviceConsentModal = observer(function DeviceConsentModal({
  serverId,
  ask,
  onSuccess,
  onClose,
}: Props) {
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const server = serverForConsent(switchServersStore.serverById(serverId));
  const label = ask.displayName && ask.displayName !== ask.name ? ask.displayName : ask.name;
  const choice = { bypass: ask.bypass, directory: ask.directory };

  const answer = async (allow: boolean) => {
    setBusy(allow ? 'allow' : 'deny');
    setError(null);
    try {
      const params = { serverId, agentId: ask.agentId, choice };
      if (allow) await rpc.embeddedController.allowForAgent(params);
      else await rpc.embeddedController.denyForAgent(params);
      onSuccess();
    } catch (cause) {
      setError(failureText(cause, allow ? 'Could not allow it.' : 'Could not record your answer.'));
      setBusy(null);
    }
  };

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Allow {label} on this computer?</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0 text-sm">
        <p>
          <span className="font-medium">{ask.name}</span>, an agent from {server}, asks to:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          {askLines(ask).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="text-foreground-muted">
          Only you can allow this, here: the server cannot. Until you do,{' '}
          {ask.directory !== null
            ? 'the agent does not start in that folder'
            : 'the agent asks before it acts'}
          . You can take it back on this computer’s page under Machines.
        </p>
        {error && (
          <p role="alert" className="text-foreground-destructive">
            {error}
          </p>
        )}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" disabled={busy !== null} onClick={() => void answer(false)}>
          {busy === 'deny' ? 'Saving…' : 'Don’t allow'}
        </Button>
        <Button variant="outline" disabled={busy !== null} onClick={onClose}>
          Decide later
        </Button>
        <Button disabled={busy !== null} onClick={() => void answer(true)}>
          {busy === 'allow' ? 'Allowing…' : 'Allow'}
        </Button>
      </DialogFooter>
    </>
  );
});
