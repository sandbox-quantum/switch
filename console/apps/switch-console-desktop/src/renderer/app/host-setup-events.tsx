import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { SettledStepTracker } from '@renderer/features/remote-hosts/setup/settled-steps';
import { invalidateHostProviderReadiness } from '@renderer/lib/components/provider-connection-status';
import { events } from '@renderer/lib/ipc';
import { hostSetupPlanEventChannel } from '@shared/core/remote-hosts/setup';

/**
 * Ask a host's providers' sign-in again when its setup finds something new.
 * Setup runs from the host page, the hosts list and Add Agent's readiness
 * probe; listening to the plan main pushes covers all of them.
 */
export function HostSetupEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const tracker = new SettledStepTracker();
    return events.on(hostSetupPlanEventChannel, (plan) => {
      if (tracker.changed(plan)) void invalidateHostProviderReadiness(queryClient, plan.sshHost);
    });
  }, [queryClient]);

  return null;
}
