import { useEffect } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events } from '@renderer/lib/ipc';
import { userFacingProblemChannel } from '@shared/events/problemEvents';

/**
 * Shows background failures the main process has no other way to report.
 *
 * Everything else in the error work moves detail out of the sentence a user
 * reads. This is the reverse case: work that failed where nobody was looking,
 * leaving a session that appears healthy and does nothing. Mounted once, near
 * the root, because the failures it reports are not scoped to any one view —
 * the user may be nowhere near the agent whose session never started.
 */
export function UserFacingProblems() {
  useEffect(
    () =>
      events.on(userFacingProblemChannel, ({ key, headline, detail }) => {
        toast({
          id: key,
          title: headline,
          description: detail ?? undefined,
          variant: 'destructive',
        });
      }),
    []
  );

  return null;
}
