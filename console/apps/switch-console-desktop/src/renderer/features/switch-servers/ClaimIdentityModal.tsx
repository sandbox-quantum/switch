import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps, useModalContext } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import type { LinkCode, LinkedIdentity } from '@shared/core/switch-servers/switch-servers';
import { AccountLinkConfirmation, type AccountLinkTarget } from './account-link-confirmation';
import { BridgeIdentitySearch } from './bridge-identity-search';
import { linkedIdentityOn } from './messaging-apps-warning';
import { useMyIdentities } from './use-my-identities';

type ClaimIdentityModalArgs = {
  /** The workspace the account is claimed in. Required rather than defaulted to
   * the active one: every entry point knows which workspace it opened from, and
   * falling back would claim the account somewhere the user was not looking. */
  workspaceId: string;
  /** The messaging app to claim an account in. */
  bridgeId: string;
  /** Open on a link that is waiting for its code — a pending one, or one made
   * before links had to be confirmed — rather than on the search. A fresh code
   * is asked for on open, since the server keeps none to show again. */
  confirm?: AccountLinkTarget;
};

type Props = BaseModalProps<{ identity: LinkedIdentity }> & ClaimIdentityModalArgs;

/**
 * Link the signed-in Switch user to their own messaging-app account
 * (CHOO-2137).
 *
 * Until Switch knows which platform account is which person, an addressing rule
 * that names an agent's owner can never recognise them — so this is what makes
 * owner-only addressing work at all, and why it is offered straight after a
 * messaging app is connected.
 *
 * The search goes to the platform's own directory rather than Switch's record
 * of who has spoken, so a user can find themselves in a workspace they have
 * never posted in.
 *
 * Saying "this is me" proves nothing, so on a current server the link then
 * waits for a one-time code posted from the account (CHOO-3881), and the
 * dialog stays open on that code until it is.
 */
export const ClaimIdentityModal = observer(function ClaimIdentityModal({
  workspaceId,
  bridgeId,
  confirm,
  onSuccess,
  onClose,
}: Props) {
  // The search raises the close guard while a claim or unlink is in flight, so
  // this is also the signal that leaving now would abandon one.
  const { hasActiveCloseGuard } = useModalContext();

  const { identities } = useMyIdentities(workspaceId);
  const [waiting, setWaiting] = useState<{
    target: AccountLinkTarget;
    code: LinkCode | null;
  } | null>(confirm ? { target: confirm, code: null } : null);

  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', workspaceId],
    queryFn: () => rpc.workspaces.listBridges(workspaceId),
  });
  const bridges = bridgesQuery.data ?? [];

  // Names the workspace being searched. Null only while the list is in flight
  // or when the named bridge has since been removed — the second is reported
  // rather than searched around.
  const selectedBridge = bridges.find((b) => b.id === bridgeId) ?? null;
  // Not while re-reading: straight after an app is added the cached list does
  // not have it yet.
  const bridgeIsGone = !bridgesQuery.isFetching && bridges.length > 0 && selectedBridge === null;
  const alreadyLinked = identities === null ? null : linkedIdentityOn(bridgeId, identities);

  const platform = bridgePlatformLabel(selectedBridge?.type);
  const bridgeDisplayName = selectedBridge?.displayName ?? 'the workspace';

  if (waiting !== null) {
    return (
      <>
        <DialogHeader showCloseButton={false}>
          <DialogTitle>Confirm your {platform} account</DialogTitle>
        </DialogHeader>
        <DialogContentArea className="pt-0">
          <AccountLinkConfirmation
            // A new target is a new code to wait on, not this one renamed.
            key={waiting.target.identityId}
            workspaceId={workspaceId}
            bridgeId={bridgeId}
            bridgeDisplayName={bridgeDisplayName}
            target={waiting.target}
            initialCode={waiting.code}
            onConfirmed={(identity) => onSuccess({ identity })}
            // Back to the search when it was reached from there — the likeliest
            // reason to cancel is having picked the wrong account.
            onCancelled={() => (confirm ? onClose() : setWaiting(null))}
            onStartAgain={() => setWaiting(null)}
          />
        </DialogContentArea>
        <DialogFooter>
          {/* Closing is not cancelling: a pending link waits, and the app's row
              on the server page offers a new code for it. */}
          <Button variant="outline" onClick={onClose} disabled={hasActiveCloseGuard}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Link your {platform} user account</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <div className="flex w-full flex-col gap-5">
          <p className="text-xs text-foreground-muted">
            Tell Switch which account is you, so your own agents can tell it&apos;s you.
          </p>

          {bridgeIsGone && (
            <p className="text-xs text-destructive">
              That messaging app is no longer connected to this workspace.
            </p>
          )}

          {alreadyLinked && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs">
              <Info className="mt-0.5 size-3.5 shrink-0 text-foreground-muted" />
              <span>
                You are already linked to{' '}
                <span className="font-medium">{alreadyLinked.externalUsername}</span> on{' '}
                {alreadyLinked.bridgeDisplayName}. Linking another account here keeps that one too —
                search for it to unlink it, or use that app&apos;s row on the server page.
              </span>
            </div>
          )}

          <BridgeIdentitySearch
            workspaceId={workspaceId}
            bridgeId={bridgeId}
            bridgeDisplayName={bridgeDisplayName}
            platform={bridgePlatformLabel(selectedBridge?.type ?? '')}
            directorySearchSupported={selectedBridge?.directorySearchSupported ?? true}
            autoFocus
            onClaimed={(identity) => onSuccess({ identity })}
            onConfirmationNeeded={(target, code) => setWaiting({ target, code })}
          />
        </div>
      </DialogContentArea>
      <DialogFooter>
        {/* Skippable on purpose: this modal interrupts whatever the user came to
            do, and an unlinked account costs them nothing until they restrict an
            agent to its owner. */}
        <Button variant="outline" onClick={onClose} disabled={hasActiveCloseGuard}>
          Skip for now
        </Button>
      </DialogFooter>
    </>
  );
});
