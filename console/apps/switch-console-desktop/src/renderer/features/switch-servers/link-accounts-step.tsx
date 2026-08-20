import { useQuery } from '@tanstack/react-query';
import { Check, Link2, MessageSquare, TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { DialogContentArea, DialogFooter } from '@renderer/lib/ui/dialog';
import { Spinner } from '@renderer/lib/ui/spinner';
import { WizardStepHeader } from '@renderer/lib/ui/wizard-step-header';
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { BridgeIdentitySearch } from './bridge-identity-search';
import { connectedAppsSummary, LINK_ACCOUNTS_LATER } from './link-accounts-prose';
import { orderBridges } from './messaging-apps-order';
import { useMyIdentities } from './use-my-identities';

/**
 * The last step of connecting to a server someone else runs: say which account
 * in each of its messaging apps is you.
 *
 * It is here rather than only on the server page because a server you connect
 * to already has its apps attached — the moment you arrive is the moment the
 * question is answerable, and the only moment you are certain to be asked.
 */
export const LinkAccountsStep = observer(function LinkAccountsStep({
  serverId,
  serverName,
  step,
  of,
  onDone,
}: {
  serverId: string;
  serverName: string;
  step: number;
  of: number;
  onDone: () => void;
}) {
  // Which app's directory is open, or null while the list is. Linking happens
  // in place: a second dialog on top of this one would bury the step it belongs
  // to and give the user two Backs meaning different things.
  const [linking, setLinking] = useState<RemoteBridge | null>(null);

  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', serverId],
    queryFn: () => rpc.switchServers.listRemoteBridges(serverId),
  });
  const { identities } = useMyIdentities(serverId);

  if (linking) {
    return (
      <>
        <WizardStepHeader
          title={`Link your ${bridgePlatformLabel(linking.type)} account`}
          step={step}
          of={of}
        />
        <DialogContentArea className="pt-0">
          <div className="flex w-full flex-col gap-4">
            <p className="text-sm text-foreground-muted">
              Find yourself in {linking.displayName} and tell Switch that account is you.
            </p>
            <BridgeIdentitySearch
              serverId={serverId}
              bridgeId={linking.id}
              bridgeDisplayName={linking.displayName}
              platform={bridgePlatformLabel(linking.type)}
              directorySearchSupported={linking.directorySearchSupported}
              autoFocus
              onClaimed={() => setLinking(null)}
            />
          </div>
        </DialogContentArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => setLinking(null)}>
            Back
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <WizardStepHeader title="Link your messaging accounts" step={step} of={of} />
      <DialogContentArea className="pt-0">
        <BridgeList
          serverName={serverName}
          bridges={bridgesQuery.isSuccess ? orderBridges(bridgesQuery.data) : null}
          identities={identities}
          isPending={bridgesQuery.isPending}
          error={bridgesQuery.isError ? bridgesQuery.error : null}
          onRetry={() => void bridgesQuery.refetch()}
          onLink={setLinking}
        />
      </DialogContentArea>
      <DialogFooter>
        <ConfirmButton onClick={onDone}>Done</ConfirmButton>
      </DialogFooter>
    </>
  );
});

function BridgeList({
  serverName,
  bridges,
  identities,
  isPending,
  error,
  onRetry,
  onLink,
}: {
  serverName: string;
  /** Null until the read succeeds — pending and failed are separate states
   * below, so this never stands in for either. */
  bridges: RemoteBridge[] | null;
  identities: LinkedIdentity[] | null;
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  onLink: (bridge: RemoteBridge) => void;
}) {
  if (isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-foreground-muted">
        <Spinner className="size-3.5" />
        Reading this server’s messaging apps…
      </p>
    );
  }

  if (error !== null) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-destructive text-sm">
          {failureText(error, 'Could not read this server’s messaging apps.')}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (bridges === null) return null;

  return (
    <div className="flex w-full flex-col gap-4">
      <p className="text-sm text-foreground-muted">
        {connectedAppsSummary(serverName, bridges.length)}
        {bridges.length > 0 && ' Link the accounts you use so your agents know who you are.'}
      </p>

      {bridges.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          There is nothing to link yet. Once an admin connects one, its row appears on the server’s
          page.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {bridges.map((bridge) => (
              <BridgeLinkRow
                key={bridge.id}
                bridge={bridge}
                identities={identities}
                onLink={() => onLink(bridge)}
              />
            ))}
          </ul>
          <p className="text-xs text-foreground-muted">{LINK_ACCOUNTS_LATER}</p>
        </>
      )}
    </div>
  );
}

function BridgeLinkRow({
  bridge,
  identities,
  onLink,
}: {
  bridge: RemoteBridge;
  /** Null while unknown — which is not the same as none, so the row shows
   * neither a handle nor a Link button until the answer arrives. */
  identities: LinkedIdentity[] | null;
  onLink: () => void;
}) {
  const identity = identities?.find((i) => i.bridgeId === bridge.id) ?? null;

  return (
    <li className="flex items-center gap-3 rounded-[10px] border border-border bg-[var(--surface-2)] px-3.5 py-3">
      <span className="flex size-6 shrink-0 items-center justify-center">
        {hasBridgeIcon(bridge.type) ? (
          <BridgeIcon bridgeType={bridge.type} size={20} />
        ) : (
          <MessageSquare className="size-5 text-foreground-muted" />
        )}
      </span>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{bridge.displayName}</span>
        {identities === null ? null : identity === null ? (
          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
            <TriangleAlert className="size-3 shrink-0" />
            No account linked
          </span>
        ) : (
          <span className="truncate font-mono text-xs text-foreground-muted">
            {handleOf(identity)}
          </span>
        )}
      </div>

      {identities !== null &&
        (identity === null ? (
          <Button variant="outline" size="sm" className="shrink-0" onClick={onLink}>
            <Link2 className="size-3.5" />
            Link account
          </Button>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 text-sm text-green-600 dark:text-green-500">
            <Check className="size-4" />
            Linked
          </span>
        ))}
    </li>
  );
}

function handleOf(identity: LinkedIdentity): string {
  const username = identity.externalUsername;
  return username.startsWith('@') ? username : `@${username}`;
}
