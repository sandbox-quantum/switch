import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';

export type RemoveAgentConfigModalArgs = {
  /** The agent's name (also the config file's stem). */
  agentName: string;
  /** The working directory holding the config, for the confirmation copy. */
  dir: string;
  /** The host the directory lives on. */
  sshHost: string;
};

export type RemoveAgentConfigModalResult = { confirmed: true };

type Props = BaseModalProps<RemoveAgentConfigModalResult> & RemoveAgentConfigModalArgs;

/**
 * Confirm deleting an agent's on-disk config from a remote host — the cleanup
 * action in "Load existing agents" (CHOO-2560). Host-file-only by design: the
 * server registration and other Consoles are untouched, and the copy says so.
 */
export function RemoveAgentConfigModal({ agentName, dir, sshHost, onSuccess, onClose }: Props) {
  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Delete agent config from host</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="flex flex-col gap-3 pt-0">
        <p className="text-sm text-foreground-muted">
          This deletes <span className="font-medium text-foreground">{agentName}</span>
          {"'"}s config file (<code>.switch/agents/{agentName}.json</code>) in{' '}
          <code className="break-all">{dir}</code> on{' '}
          <span className="font-medium text-foreground">{sshHost}</span>.
        </p>
        <p className="text-xs text-foreground-muted">
          The agent{"'"}s registration on the Switch server is not affected, and neither is any
          Console already running it. The file{"'"}s API token cannot be recovered.
        </p>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton variant="destructive" onClick={() => onSuccess({ confirmed: true })}>
          Delete config
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
