import { useState } from 'react';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { removesProvisionedFiles } from './delete-agent-choices';

export type DeleteAgentModalArgs = {
  /** Switch Console id of the agent to remove. */
  agentId: string;
  /** Display name for the agent (its Switch name, falling back to the location). */
  agentLabel: string;
  /** The agent's host (null = this machine), for naming where its files live. */
  sshHost: string | null;
  /** The agent's working directory, for naming where its files live. */
  dir: string | null;
  /**
   * Set when this Console only observes the agent (CHOO-2893): the account that
   * runs it, or "another account". Such an agent can only be removed from this
   * Console — its files, sessions and identity are its owner's.
   */
  observedOwner: string | null;
};

/** What the confirm resolves with: what to tear down beyond this Console's row. */
export type DeleteAgentModalResult = { deleteInSwitch: boolean; removeProvisionedFiles: boolean };

type Props = BaseModalProps<DeleteAgentModalResult> & DeleteAgentModalArgs;

export function DeleteAgentModal({
  agentLabel,
  sshHost,
  dir,
  observedOwner,
  onSuccess,
  onClose,
}: Props) {
  if (observedOwner !== null) {
    return (
      <>
        <DialogHeader showCloseButton={false}>
          <DialogTitle>Remove agent</DialogTitle>
        </DialogHeader>
        <DialogContentArea className="flex flex-col gap-4 pt-0">
          <p className="text-sm text-foreground-muted">
            <span className="font-medium text-foreground">{agentLabel}</span> will be removed from
            this Switch Console. It keeps running under {observedOwner}
            {sshHost ? ` on ${sshHost}` : ''}, with its files, sessions and Switch identity
            untouched — you can follow it again from the host’s Load existing agents.
          </p>
        </DialogContentArea>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <ConfirmButton
            variant="destructive"
            onClick={() => onSuccess({ deleteInSwitch: false, removeProvisionedFiles: false })}
          >
            Remove
          </ConfirmButton>
        </DialogFooter>
      </>
    );
  }
  return (
    <OwnedAgentRemoval
      agentLabel={agentLabel}
      sshHost={sshHost}
      dir={dir}
      onSuccess={onSuccess}
      onClose={onClose}
    />
  );
}

function OwnedAgentRemoval({
  agentLabel,
  sshHost,
  dir,
  onSuccess,
  onClose,
}: Omit<Props, 'agentId' | 'observedOwner'>) {
  const [deleteInSwitch, setDeleteInSwitch] = useState(false);
  const [chosen, setChosen] = useState(false);
  const onThisMachine = sshHost === null;
  const filesPlace = dir ? (sshHost ? `${sshHost}:${dir}` : dir) : null;
  const removeProvisionedFiles = removesProvisionedFiles({ sshHost, dir, chosen, deleteInSwitch });
  // Deleting it in Switch takes it off the host as well, so the host box
  // follows and cannot be unticked (CHOO-2893).
  const removeFromHost = !onThisMachine && removeProvisionedFiles;

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Remove agent</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="flex flex-col gap-4 pt-0">
        <p className="text-sm text-foreground-muted">
          <span className="font-medium text-foreground">{agentLabel}</span> will be removed from
          Switch Console.{' '}
          {onThisMachine
            ? 'Its sessions stop, and the credentials and definition files Console provisioned for it are deleted. The working directory itself, and everything else in it, are left alone.'
            : `It keeps running on ${sshHost}, with its automatic sessions and for anyone else who uses it there, unless you choose below.`}
        </p>

        {onThisMachine && filesPlace && (
          <p className="text-xs text-foreground-muted">
            Files removed from <code className="break-all">{filesPlace}</code>.
          </p>
        )}

        {!onThisMachine && filesPlace && (
          <label
            className={`group/field flex items-start gap-2.5 ${deleteInSwitch ? 'cursor-default' : 'cursor-pointer'}`}
          >
            <Checkbox
              checked={removeFromHost}
              disabled={deleteInSwitch}
              onCheckedChange={(checked) => setChosen(checked === true)}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Also remove it from {sshHost}</span>
              <span className="text-xs text-foreground-muted">
                {deleteInSwitch ? <>Deleting it in Switch removes it from {sshHost} too. </> : null}
                Stops it running there and deletes the credentials and definition files Console
                provisioned in <code className="break-all">{dir}</code>; the rest of the directory
                is left alone. Anyone else using this agent on {sshHost} loses it too — an agent you
                loaded rather than created is usually best left running.
              </span>
            </span>
          </label>
        )}

        <label className="group/field flex cursor-pointer items-start gap-2.5">
          <Checkbox
            checked={deleteInSwitch}
            onCheckedChange={(checked) => setDeleteInSwitch(checked === true)}
            className="mt-0.5"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Also delete this agent in Switch</span>
            <span className="text-xs text-foreground-muted">
              Permanently deletes its identity on the Switch server
              {onThisMachine ? '' : ` and removes it from ${sshHost}`}. This can’t be undone. Only
              this agent is affected — others in the same directory are left alone.
            </span>
          </span>
        </label>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton
          variant="destructive"
          onClick={() => onSuccess({ deleteInSwitch, removeProvisionedFiles })}
        >
          {deleteInSwitch
            ? 'Remove & delete in Switch'
            : removeFromHost
              ? `Remove from Console & ${sshHost}`
              : 'Remove'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
