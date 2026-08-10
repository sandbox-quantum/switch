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
  /** switchdash id of the agent to remove. */
  agentId: string;
  /** Display name for the agent (its Switch name, falling back to the location). */
  agentLabel: string;
};

/** What the confirm resolves with: whether to also delete the agent in Switch. */
export type DeleteAgentModalResult = { deleteInSwitch: boolean };

type Props = BaseModalProps<DeleteAgentModalResult> & DeleteAgentModalArgs;

export function DeleteAgentModal({ agentLabel, onSuccess, onClose }: Props) {
  const [deleteInSwitch, setDeleteInSwitch] = useState(false);

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Remove agent</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="flex flex-col gap-4 pt-0">
        <p className="text-sm text-foreground-muted">
          <span className="font-medium text-foreground">{agentLabel}</span> will be removed from
          Switch Console and the Switch credentials it stored on this machine will be cleared. The
          folder stays on the filesystem.
        </p>

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
        <ConfirmButton variant="destructive" onClick={() => onSuccess({ deleteInSwitch })}>
          {deleteInSwitch ? 'Remove & delete in Switch' : 'Remove'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
