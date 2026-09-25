import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { observer } from 'mobx-react-lite';
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
import type { LinkedIdentity } from '@shared/core/switch-servers/switch-servers';
import { BridgeIdentitySearch } from './bridge-identity-search';
import { switchServersStore } from './switch-servers-store';
import { useMyIdentities } from './use-my-identities';

type ClaimIdentityModalArgs = {
  /** Claim on this server instead of the active one. */
  serverId?: string;
  /** The messaging app to claim an account in. Required: an account is claimed
   * in one workspace, and every entry point knows which one it opened from —
   * asking again would be a question the caller has already answered. */
  bridgeId: string;
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
 */
export const ClaimIdentityModal = observer(function ClaimIdentityModal({
  serverId: overrideServerId,
  bridgeId,
  onSuccess,
  onClose,
}: Props) {
  const serverId = overrideServerId ?? switchServersStore.activeServerId ?? '';
  // The search raises the close guard while a claim or unlink is in flight, so
  // this is also the signal that leaving now would abandon one.
  const { hasActiveCloseGuard } = useModalContext();

  const { identities } = useMyIdentities(serverId || null);

  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', serverId],
    queryFn: () => rpc.switchServers.listRemoteBridges(serverId),
    enabled: !!serverId,
  });
  const bridges = bridgesQuery.data ?? [];

  // Names the workspace being searched. Null only while the list is in flight
  // or when the named bridge has since been removed — the second is reported
  // rather than searched around.
  const selectedBridge = bridges.find((b) => b.id === bridgeId) ?? null;
  const bridgeIsGone = !bridgesQuery.isLoading && bridges.length > 0 && selectedBridge === null;
  const alreadyLinked = (identities ?? []).find((i) => i.bridgeId === bridgeId) ?? null;

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>
          Link your {bridgePlatformLabel(selectedBridge?.type)} user account
        </DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <div className="flex w-full flex-col gap-5">
          <p className="text-xs text-foreground-muted">
            Tell Switch which account is you, so your own agents can tell it&apos;s you.
          </p>

          {!serverId && (
            <p className="text-xs text-destructive">
              No Switch server is selected. Choose a server in the sidebar first.
            </p>
          )}

          {bridgeIsGone && (
            <p className="text-xs text-destructive">
              That messaging app is no longer connected to this server.
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
            serverId={serverId}
            bridgeId={bridgeId}
            bridgeDisplayName={selectedBridge?.displayName ?? 'the workspace'}
            platform={bridgePlatformLabel(selectedBridge?.type ?? '')}
            directorySearchSupported={selectedBridge?.directorySearchSupported ?? true}
            autoFocus
            onClaimed={(identity) => onSuccess({ identity })}
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
