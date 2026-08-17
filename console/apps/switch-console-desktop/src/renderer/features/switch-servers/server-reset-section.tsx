import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogContentArea,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';

/**
 * Throwing away a managed stack, at the very bottom of its server's page.
 *
 * Last and on its own, below a rule: it is the one thing here that destroys
 * work, and it should not sit next to Start and Stop where a misread costs
 * every agent on the server.
 */
export function ServerResetSection({
  dialogTitle,
  disabled,
  onConfirm,
}: {
  /** Names the stack being destroyed — the confirmation has to say which. */
  dialogTitle: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium text-foreground">Reset</h3>
          <p className="text-xs text-foreground-muted">
            Permanently deletes the stack's data and every agent configured against it.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className="shrink-0 border-red-500/40 text-red-500 hover:bg-red-500/10 hover:text-red-500"
          onClick={() => setOpen(true)}
        >
          Reset…
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <TriangleAlert className="size-4 text-red-500" />
            <DialogTitle>{dialogTitle}</DialogTitle>
          </DialogHeader>
          <DialogContentArea>
            <DialogDescription>
              This permanently deletes this managed server and everything on it — all rooms,
              messages, and{' '}
              <strong className="text-foreground">every agent you've configured against it</strong>.
              This can't be undone. A fresh Start rebuilds an empty stack from scratch.
            </DialogDescription>
          </DialogContentArea>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Reset and delete all agents
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
