import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { events, rpc } from '@renderer/lib/ipc';
import type { ThisComputerReport } from '@shared/core/managed-agents/managed-agents';
import { embeddedControllerStateChannel } from '@shared/events/embeddedControllerEvents';

export const THIS_COMPUTER_REPORT_KEY = ['this-computer-report'] as const;

/**
 * This computer's providers as its agents controller last reported them to
 * Switch, or null when it runs no controller with a report. Settings → Agent
 * providers shows this when there is one, so it says what switch-buddy and
 * the New agent form say; Console's own check is the fallback.
 */
export function useThisComputerReport() {
  const queryClient = useQueryClient();
  // A controller that stops, starts or is turned off, or a server removed,
  // changes which report there is: read it again at once rather than show
  // the old one until the next poll.
  useEffect(
    () =>
      events.on(embeddedControllerStateChannel, () => {
        void queryClient.invalidateQueries({ queryKey: THIS_COMPUTER_REPORT_KEY });
      }),
    [queryClient]
  );
  return useQuery<ThisComputerReport | null>({
    queryKey: THIS_COMPUTER_REPORT_KEY,
    // The server Console is on now first: controllers on different servers
    // can report differently, and that one is what buddy and the forms use.
    queryFn: () => rpc.managedAgents.thisComputerProviders(switchServersStore.activeServerId),
    staleTime: 10_000,
    // While the page is open, so a sign-in finished elsewhere, a check still
    // running, or a server signed out of shows up without a refresh; the
    // controller reports on its own about as often.
    refetchInterval: 15_000,
    retry: false,
  });
}

/**
 * Has this computer's controller check every provider again and report it,
 * then reads the report anew: after a refresh, an install or an update, so
 * the screen does not go on showing what the controller saw before. Does
 * nothing beyond the reread when there is no controller report to refresh.
 */
export async function recheckThisComputer(queryClient: QueryClient): Promise<void> {
  const report = queryClient.getQueryData<ThisComputerReport | null>(THIS_COMPUTER_REPORT_KEY);
  try {
    if (report) await rpc.embeddedController.recheckProviders(report.serverId);
  } catch {
    // The controller stopped or the server went away: the reread falls back
    // to Console's own check, which is all there is to show then.
  }
  await queryClient.invalidateQueries({ queryKey: THIS_COMPUTER_REPORT_KEY });
}
