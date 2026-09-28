import { TriangleAlert } from 'lucide-react';
import { type ReactNode, useState } from 'react';
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
import { remoteServerStore } from './remote-server-store';
import { sharedWithOthers, whoElseSentence } from './shared-consoles';

/** A lifecycle action that reaches everyone using a shared remote server. */
export type SharedAction = 'stop' | 'restart';

/**
 * Ask before a stop or restart of a remote server reaches the other people
 * using it (CHOO-2893), wherever the action is offered — the stack's controls,
 * or a notice that restarts it to apply something.
 *
 * Asked when others have used it lately, and also when that cannot be told
 * because who uses it has not been read: the same rule the main process
 * follows, where an unreadable register counts as others using the server.
 * Pass null for a server nobody else shares (the local one), which never asks.
 *
 * Read from an observer component, since the register lives in a MobX store.
 */
export function useSharedActionConfirm(sshHost: string | null): {
  request: (action: SharedAction, run: () => void) => void;
  dialog: ReactNode;
  /** Whether an action here reaches anyone else, as the confirmation decides it. */
  shared: boolean;
  /** Who else it reaches, for a notice that names them; null when nobody. */
  who: string | null;
} {
  const [pending, setPending] = useState<{ action: SharedAction; run: () => void } | null>(null);
  const register = sshHost ? remoteServerStore.registerFor(sshHost) : null;
  const now = new Date();
  const shared = sshHost !== null && sharedWithOthers(register, now);
  const who = sshHost !== null ? whoElseSentence(register, now) : null;

  const request = (action: SharedAction, run: () => void) => {
    if (shared) setPending({ action, run });
    else run();
  };

  const dialog = (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <DialogContent>
        <DialogHeader>
          <TriangleAlert className="size-4 text-amber-500" />
          <DialogTitle>
            {pending?.action === 'stop'
              ? `Stop the server on ${sshHost} for everyone?`
              : `Restart the server on ${sshHost} for everyone?`}
          </DialogTitle>
        </DialogHeader>
        <DialogContentArea>
          <DialogDescription>
            {who}{' '}
            {pending?.action === 'stop'
              ? 'Their agents stop answering until someone starts it again. Its rooms, agents and data are kept.'
              : 'Their agents stop answering while it restarts, and it comes back on the version this Console runs.'}
          </DialogDescription>
        </DialogContentArea>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button
            variant={pending?.action === 'stop' ? 'destructive' : 'default'}
            size="sm"
            onClick={() => {
              const run = pending?.run;
              setPending(null);
              run?.();
            }}
          >
            {pending?.action === 'stop' ? 'Stop for everyone' : 'Restart for everyone'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { request, dialog, shared, who };
}
