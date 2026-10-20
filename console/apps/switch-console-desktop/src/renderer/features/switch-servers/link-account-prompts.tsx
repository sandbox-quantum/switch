import { Link2 } from 'lucide-react';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { messagingAppsToLink } from './messaging-apps-warning';

/**
 * "Link your <app> account", once for each active app the signed-in user has
 * no account linked on.
 *
 * Adding an app ends with the link step, and the step can be skipped; this is
 * where it is offered again, on the server home, until the account is linked.
 * Claiming refreshes the identity list it reads, so a prompt goes away as soon
 * as its account is linked.
 */
export function LinkAccountPrompts({
  workspaceId,
  bridges,
  identities,
}: {
  workspaceId: string | null;
  bridges: RemoteBridge[];
  /** Null while unknown: nothing is prompted until the list has arrived. */
  identities: LinkedIdentity[] | null;
}) {
  const showClaimIdentity = useShowModal('claimIdentityModal');
  if (workspaceId === null) return null;
  const toLink = messagingAppsToLink(bridges, identities);
  if (toLink.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {toLink.map((bridge) => {
        const platform = bridgePlatformLabel(bridge.type);
        return (
          <Alert key={bridge.id} data-testid={`link-account-prompt-${bridge.id}`}>
            <Link2 className="size-4" />
            <AlertTitle>Link your {platform} account</AlertTitle>
            <AlertDescription>
              So your agents recognise you in {bridge.displayName}.
            </AlertDescription>
            <AlertAction>
              <Button
                size="sm"
                variant="outline"
                onClick={() => showClaimIdentity({ workspaceId, bridgeId: bridge.id })}
              >
                Link account
              </Button>
            </AlertAction>
          </Alert>
        );
      })}
    </div>
  );
}
