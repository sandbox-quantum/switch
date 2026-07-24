import { TriangleAlert } from 'lucide-react';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';

export type ResetAgentModalArgs = {
  /** Display name for the agent (its Switch name, falling back to the location). */
  agentLabel: string;
};

type Props = BaseModalProps<void> & ResetAgentModalArgs;

export function ResetAgentModal({ agentLabel, onSuccess, onClose }: Props) {
  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Reset agent</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="flex flex-col gap-4 pt-0">
        <p className="text-sm text-foreground-muted">
          <span className="font-medium text-foreground">{agentLabel}</span> will be reset.
          switchdash kills all of its remote sessions — the watcher and every running session — then
          restarts it fresh.
        </p>

        <div className="border-destructive/30 bg-destructive/10 flex items-start gap-2.5 rounded-md border p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-foreground-destructive" />
          <span className="text-foreground-muted">
            Any in-progress work in those sessions will be lost. This can’t be undone.
          </span>
        </div>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton variant="destructive" onClick={() => onSuccess()}>
          Reset
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
