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
 * What this Console can do is follow the agent's sessions, which is what the
 * page goes on to list.
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
          From here you can follow its sessions as they happen, send them prompts and stop them —
          all through the Switch server you both use. New sessions start where the agent runs: from
          a room, or from that account’s Console.
        </p>
      </AlertDescription>
    </Alert>
  );
});
