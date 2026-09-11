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

export type DeleteAgentModalArgs = {
  /** Switch Console id of the agent to remove. */
  agentId: string;
  /** Display name for the agent (its Switch name, falling back to the location). */
  agentLabel: string;
  /** The agent's host (null = this machine), for naming where its files live. */
  sshHost: string | null;
  /** The agent's working directory, for naming where its files live. */
  dir: string | null;
};

/** What the confirm resolves with: what to tear down beyond this Console's row. */
export type DeleteAgentModalResult = { deleteInSwitch: boolean; removeProvisionedFiles: boolean };

type Props = BaseModalProps<DeleteAgentModalResult> & DeleteAgentModalArgs;

export function DeleteAgentModal({ agentLabel, sshHost, dir, onSuccess, onClose }: Props) {
  const [deleteInSwitch, setDeleteInSwitch] = useState(false);
  const [removeProvisionedFiles, setRemoveProvisionedFiles] = useState(false);
  const filesPlace = dir ? (sshHost ? `${sshHost}:${dir}` : dir) : null;

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Remove agent</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="flex flex-col gap-4 pt-0">
        <p className="text-sm text-foreground-muted">
          <span className="font-medium text-foreground">{agentLabel}</span> will be removed from
          Switch Console. Its working directory, the credentials stored there, and any running
          sidecar are untouched unless you choose below.
        </p>

        {filesPlace && (
          <label className="group/field flex cursor-pointer items-start gap-2.5">
            <Checkbox
              checked={removeProvisionedFiles}
              onCheckedChange={(checked) => setRemoveProvisionedFiles(checked === true)}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">
                Also delete its files on <code className="break-all">{filesPlace}</code>
              </span>
              <span className="text-xs text-foreground-muted">
                Removes the credentials and definition files provisioned in the working directory
                and stops the agent{"'"}s sidecar.
                {sshHost
                  ? ' On a shared host these may belong to another install — an agent you loaded rather than created should usually keep them.'
                  : ''}
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
              Permanently deletes its identity on the Switch server. This can’t be undone. Only this
              agent is affected — others in the same directory are left alone.
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
          {deleteInSwitch ? 'Remove & delete in Switch' : 'Remove'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
