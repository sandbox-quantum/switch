import { KeyRound, Link2, ShieldCheck } from 'lucide-react';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import type {
  LinkedIdentity,
  PendingIdentity,
  RemoteBridge,
} from '@shared/core/switch-servers/switch-servers';
import type { AccountLinkTarget } from './account-link-confirmation';
import { accountHandle } from './link-accounts-prose';
import { type AccountLinkPrompt, accountLinkPrompts } from './messaging-apps-warning';

/**
 * One prompt for each active app whose account still needs something from the
 * signed-in user: "Link your <app> account" while none is linked, "Finish
 * linking" while a link waits for its code, and "Confirm" for a link made
 * before links had to be confirmed.
 *
 * Adding an app ends with the link step, and the step can be skipped; this is
 * where it is offered again, on the server home, until the account is linked.
 * Claiming and confirming refresh the lists it reads, so a prompt goes away as
 * soon as it is answered.
 */
export function LinkAccountPrompts({
  workspaceId,
  bridges,
  identities,
  pending,
}: {
  workspaceId: string | null;
  bridges: RemoteBridge[];
  /** Null while unknown: nothing is prompted until the list has arrived. */
  identities: LinkedIdentity[] | null;
  /** Links waiting for a code; null while unknown. */
  pending: PendingIdentity[] | null;
}) {
  const showClaimIdentity = useShowModal('claimIdentityModal');
  if (workspaceId === null) return null;
  const prompts = accountLinkPrompts(bridges, identities, pending);
  if (prompts.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {prompts.map((prompt) => (
        <Alert key={prompt.bridge.id} data-testid={`link-account-prompt-${prompt.bridge.id}`}>
          <PromptBody
            prompt={prompt}
            onAct={() => {
              const confirm = confirmTargetOf(prompt);
              showClaimIdentity(
                confirm === null
                  ? { workspaceId, bridgeId: prompt.bridge.id }
                  : { workspaceId, bridgeId: prompt.bridge.id, confirm }
              );
            }}
          />
        </Alert>
      ))}
    </div>
  );
}

/** The link the dialog opens on, waiting for its code; null opens the search. */
function confirmTargetOf(prompt: AccountLinkPrompt): AccountLinkTarget | null {
  switch (prompt.kind) {
    case 'link':
      return null;
    case 'pending':
      return {
        identityId: prompt.link.id,
        externalUsername: prompt.link.externalUsername,
        kind: 'pending',
      };
    case 'unverified':
      return {
        identityId: prompt.identity.id,
        externalUsername: prompt.identity.externalUsername,
        kind: 'unverified',
      };
  }
}

function PromptBody({ prompt, onAct }: { prompt: AccountLinkPrompt; onAct: () => void }) {
  const platform = bridgePlatformLabel(prompt.bridge.type);
  const app = prompt.bridge.displayName;
  switch (prompt.kind) {
    case 'link':
      return (
        <>
          <Link2 className="size-4" />
          <AlertTitle>Link your {platform} account</AlertTitle>
          <AlertDescription>So your agents recognise you in {app}.</AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={onAct}>
              Link account
            </Button>
          </AlertAction>
        </>
      );
    case 'pending': {
      const handle = accountHandle(prompt.link.externalUsername);
      return (
        <>
          <KeyRound className="size-4" />
          <AlertTitle>Finish linking your {platform} account</AlertTitle>
          <AlertDescription>
            {prompt.link.requestedByName !== null
              ? `${prompt.link.requestedByName} started linking ${handle} in ${app} to you. Post a code from that account to confirm it’s yours.`
              : `Waiting for a code to be posted from ${handle} in ${app}.`}
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={onAct}>
              Show code
            </Button>
          </AlertAction>
        </>
      );
    }
    case 'unverified': {
      const handle = accountHandle(prompt.identity.externalUsername);
      return (
        <>
          <ShieldCheck className="size-4" />
          <AlertTitle>Confirm your {platform} account</AlertTitle>
          <AlertDescription>
            {handle} in {app} is linked but not confirmed. Post a one-time code from it to show it’s
            yours.
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={onAct}>
              Confirm
            </Button>
          </AlertAction>
        </>
      );
    }
  }
}
