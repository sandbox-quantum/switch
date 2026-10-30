import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';
import { accountHandle, linkRequestFailureText } from './link-accounts-prose';
import { unconfirmedLinksQuery, unconfirmedLinksQueryKey } from './unconfirmed-links';
import { myIdentitiesQueryKey } from './use-my-identities';

type RequireLinkConfirmationModalArgs = {
  workspaceId: string;
  bridgeId: string;
  bridgeDisplayName: string;
};

type Props = BaseModalProps<{ moved: number }> & RequireLinkConfirmationModalArgs;

/**
 * Stop trusting a messaging app's links made before links had to be confirmed
 * (CHOO-3881). Admin only.
 *
 * Nobody proved those accounts were theirs, so an admin can make each one wait
 * for its owner's code like a new link. It stops counting at once, which locks
 * people out of their own owner-only agents until they post the code — so the
 * dialog names everyone affected and says so before anything moves.
 */
export const RequireLinkConfirmationModal = observer(function RequireLinkConfirmationModal({
  workspaceId,
  bridgeId,
  bridgeDisplayName,
  onSuccess,
  onClose,
}: Props) {
  const queryClient = useQueryClient();
  const linksQuery = useQuery(unconfirmedLinksQuery(workspaceId, bridgeId));
  const links = linksQuery.data ?? null;
  const [requiring, setRequiring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRequire = async () => {
    setRequiring(true);
    setError(null);
    try {
      const result = await rpc.workspaces.requireLinkConfirmation({ workspaceId, bridgeId });
      if (result.kind !== 'required') {
        setError(linkRequestFailureText(result));
        setRequiring(false);
        return;
      }
      // The linked and pending lists sit under one key; the older links are
      // the ones just moved.
      void queryClient.invalidateQueries({ queryKey: myIdentitiesQueryKey(workspaceId) });
      void queryClient.invalidateQueries({
        queryKey: unconfirmedLinksQueryKey(workspaceId, bridgeId),
      });
      toast({ title: movedText(result.moved) });
      onSuccess({ moved: result.moved });
    } catch (cause) {
      setError(failureText(cause, 'Could not require confirmation.'));
      setRequiring(false);
    }
  };

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Require confirmation for older links?</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-3 pt-0">
        <p className="text-sm text-foreground-muted">
          These links in {bridgeDisplayName} were made before links had to be confirmed, so nobody
          proved they own the account.
        </p>

        {linksQuery.isError ? (
          <p className="text-xs text-destructive">
            {failureText(linksQuery.error, 'Could not read the older links.')}
          </p>
        ) : links === null ? (
          <p className="flex items-center gap-2 text-xs text-foreground-muted">
            <Spinner className="size-3.5" />
            Reading the links…
          </p>
        ) : links.length === 0 ? (
          <p className="text-xs text-foreground-muted">
            No older links are left in {bridgeDisplayName}.
          </p>
        ) : (
          <ul
            className="flex max-h-56 flex-col gap-1 overflow-y-auto"
            data-testid="unconfirmed-links"
          >
            {links.map((link) => (
              <li
                key={`${link.id}:${link.userId}`}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-2 py-1.5 text-sm"
              >
                <span className="truncate text-foreground">{link.userName}</span>
                <span className="truncate font-mono text-xs text-foreground-muted">
                  {accountHandle(link.externalUsername)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <span>
            Until each person posts the code Console shows them, agents that answer only their owner
            won’t recognise them in {bridgeDisplayName}.
          </span>
        </div>

        {error !== null && <p className="text-xs text-destructive">{error}</p>}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={requiring}>
          Cancel
        </Button>
        <ConfirmButton
          onClick={() => void handleRequire()}
          disabled={requiring || links === null || links.length === 0}
        >
          {requiring ? 'Requiring…' : 'Require confirmation'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});

function movedText(moved: number): string {
  if (moved === 0) return 'No links needed confirming';
  return moved === 1 ? '1 link now needs confirming' : `${moved} links now need confirming`;
}
