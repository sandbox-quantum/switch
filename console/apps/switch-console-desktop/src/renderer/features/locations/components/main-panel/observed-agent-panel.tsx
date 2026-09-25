import { Eye } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { getLocationStore } from '@renderer/features/locations/stores/location-selectors';
import { Alert, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';

/**
 * What an agent page shows in place of the agent's settings, when this Console
 * observes the agent rather than running it (CHOO-2893).
 *
 * Instructions, launch settings, auto-approve, automatic sessions and the
 * sidecar all live where the agent runs, under the account that owns it — none
 * of them is readable from here, and none of them is this Console's to change.
 * Nor are its sessions: each one lives on the host, in that account's home, so
 * only a Console signed in as that account can open it. What is shared is the
 * Switch server, where the agent can be talked to in rooms like any other.
 */
export const ObservedAgentPanel = observer(function ObservedAgentPanel({
  locationId,
}: {
  locationId: string;
}) {
  const location = getLocationStore(locationId)?.data;
  if (!location) return null;
  const owner = location.observedOwner
    ? `the account ${location.observedOwner}`
    : 'another account';

  return (
    <Alert>
      <Eye className="size-4" />
      <AlertTitle>
        Runs under {owner} on {location.sshHost}
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          That account’s Switch Console runs this agent, from {location.dir}. Its instructions,
          settings, automatic sessions and sidecar are managed there.
        </p>
        <p>
          Its sessions run there too, and open only from a Switch Console signed in as that account,
          so none are listed here. You can still talk to it in a room on the Switch server you both
          use — it answers there as it would anyone.
        </p>
      </AlertDescription>
    </Alert>
  );
});
