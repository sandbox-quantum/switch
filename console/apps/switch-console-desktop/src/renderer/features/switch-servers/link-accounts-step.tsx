import { useQuery } from '@tanstack/react-query';
import {
  Check,
  Clock,
  KeyRound,
  Link2,
  MessageSquare,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { WizardFrame } from '@renderer/lib/ui/wizard-frame';
import type {
  LinkCode,
  LinkedIdentity,
  PendingIdentity,
  RemoteBridge,
} from '@shared/core/switch-servers/switch-servers';
import { AccountLinkConfirmation, type AccountLinkTarget } from './account-link-confirmation';
import { BridgeIdentitySearch } from './bridge-identity-search';
import { accountHandle, connectedAppsSummary, LINK_ACCOUNTS_LATER } from './link-accounts-prose';
import { orderBridges } from './messaging-apps-order';
import { linkedIdentityOn } from './messaging-apps-warning';
import { useMyIdentities, useMyPendingIdentities } from './use-my-identities';

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
  onDone,
}: {
  serverId: string;
  serverName: string;
  onDone: () => void;
}) {
  // Which app's directory is open, or null while the list is. Linking happens
  // in place: a second dialog on top of this one would bury the step it belongs
  // to and give the user two Backs meaning different things. `waiting` is set
  // while a link waits for its code to be posted, which happens in place too.
  const [linking, setLinking] = useState<{
    bridge: RemoteBridge;
    waiting: { target: AccountLinkTarget; code: LinkCode | null } | null;
  } | null>(null);

  const workspaceId = workspacesStore.idOnServerInScope(serverId);
  const bridgesQuery = useQuery({
    queryKey: ['remote-bridges', workspaceId],
    queryFn: () => rpc.workspaces.listBridges(workspaceId as string),
    enabled: workspaceId !== null,
  });
  // A disabled query never leaves its pending state, so without this the page
  // would spin on "reading the apps" forever and never say that it is not
  // reading anything. Messaging apps hang off a workspace; with none in scope
  // there is nothing to list and nothing to link an account to.
  const noWorkspace =
    workspaceId === null
      ? new Error(`Your account has no workspace on ${serverName} to link accounts in.`)
      : null;
  const { identities } = useMyIdentities(workspaceId);
  const { pending } = useMyPendingIdentities(workspaceId);

  // The footer's Back and the pager's back arrow are the same move, so they
  // read one const.
  const goBack = () => setLinking(null);

  if (linking && workspaceId !== null) {
    const { bridge, waiting } = linking;
    const platform = bridgePlatformLabel(bridge.type);
    return (
      <WizardFrame
        title={waiting ? `Confirm your ${platform} account` : `Link your ${platform} account`}
        subtitle={null}
        pager={{
          pageName: `Link ${platform}`,
          onBack: goBack,
          onNext: null,
        }}
        footer={
          <Button variant="outline" onClick={goBack}>
            Back
          </Button>
        }
      >
        {waiting ? (
          <AccountLinkConfirmation
            key={waiting.target.identityId}
            workspaceId={workspaceId}
            bridgeId={bridge.id}
            bridgeDisplayName={bridge.displayName}
            target={waiting.target}
            initialCode={waiting.code}
            onConfirmed={goBack}
            onCancelled={() => setLinking({ bridge, waiting: null })}
            onStartAgain={() => setLinking({ bridge, waiting: null })}
          />
        ) : (
          <div className="flex w-full flex-col gap-4">
            <p className="text-sm text-foreground-muted">
              Find yourself in {bridge.displayName} and tell Switch that account is you.
            </p>
            <BridgeIdentitySearch
              workspaceId={workspaceId}
              bridgeId={bridge.id}
              bridgeDisplayName={bridge.displayName}
              platform={platform}
              directorySearchSupported={bridge.directorySearchSupported}
              autoFocus
              onClaimed={goBack}
              onConfirmationNeeded={(target, code) =>
                setLinking({ bridge, waiting: { target, code } })
              }
            />
          </div>
        )}
      </WizardFrame>
    );
  }

  return (
    <WizardFrame
      title="Link your messaging accounts"
      subtitle={null}
      /* The last page of the flow, and signing in cannot be undone by walking
         backwards, so there is nowhere for either arrow to go. */
      pager={{ pageName: 'Link accounts', onBack: null, onNext: null }}
      footer={<ConfirmButton onClick={onDone}>Done</ConfirmButton>}
    >
      <BridgeList
        serverName={serverName}
        bridges={bridgesQuery.isSuccess ? orderBridges(bridgesQuery.data) : null}
        identities={identities}
        pending={pending}
        isPending={noWorkspace === null && bridgesQuery.isPending}
        error={noWorkspace ?? (bridgesQuery.isError ? bridgesQuery.error : null)}
        onRetry={() =>
          void (noWorkspace === null ? bridgesQuery.refetch() : workspacesStore.refresh())
        }
        onLink={(bridge, waiting) => setLinking({ bridge, waiting })}
      />
    </WizardFrame>
  );
});

function BridgeList({
  serverName,
  bridges,
  identities,
  pending,
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
  pending: PendingIdentity[] | null;
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  /** Opens the app's search, or — with a link waiting for its code — the code. */
  onLink: (
    bridge: RemoteBridge,
    waiting: { target: AccountLinkTarget; code: LinkCode | null } | null
  ) => void;
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
        <p className="text-sm text-destructive">
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
                pending={pending}
                onLink={() => onLink(bridge, null)}
                onConfirm={(target) => onLink(bridge, { target, code: null })}
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
  pending,
  onLink,
  onConfirm,
}: {
  bridge: RemoteBridge;
  /** Null while unknown — which is not the same as none, so the row shows
   * neither a handle nor a Link button until the answer arrives. */
  identities: LinkedIdentity[] | null;
  /** Links waiting for a code; null while unknown. */
  pending: PendingIdentity[] | null;
  onLink: () => void;
  onConfirm: (target: AccountLinkTarget) => void;
}) {
  const identity = identities === null ? null : linkedIdentityOn(bridge.id, identities);
  const waiting =
    identity === null ? (pending?.find((p) => p.bridgeId === bridge.id) ?? null) : null;

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
        {identities === null ? null : identity !== null ? (
          <span className="truncate font-mono text-xs text-foreground-muted">
            {accountHandle(identity.externalUsername)}
          </span>
        ) : waiting !== null ? (
          <span className="flex items-center gap-1 truncate text-xs text-foreground-muted">
            <Clock className="size-3 shrink-0" />
            <span className="font-mono">{accountHandle(waiting.externalUsername)}</span> · Waiting
            for confirmation
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
            <TriangleAlert className="size-3 shrink-0" />
            No account linked
          </span>
        )}
      </div>

      {identities !== null &&
        (identity !== null ? (
          identity.verified ? (
            <span className="flex shrink-0 items-center gap-1.5 text-sm text-green-600 dark:text-green-500">
              <Check className="size-4" />
              Linked
            </span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() =>
                onConfirm({
                  identityId: identity.id,
                  externalUsername: identity.externalUsername,
                  kind: 'unverified',
                })
              }
            >
              <ShieldCheck className="size-3.5" />
              Confirm
            </Button>
          )
        ) : waiting !== null ? (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() =>
              onConfirm({
                identityId: waiting.id,
                externalUsername: waiting.externalUsername,
                kind: 'pending',
              })
            }
          >
            <KeyRound className="size-3.5" />
            Show code
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="shrink-0" onClick={onLink}>
            <Link2 className="size-3.5" />
            Link account
          </Button>
        ))}
    </li>
  );
}
