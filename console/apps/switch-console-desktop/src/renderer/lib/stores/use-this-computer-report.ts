import { type QueryClient, useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import type { ThisComputerReport } from '@shared/core/managed-agents/managed-agents';

export const THIS_COMPUTER_REPORT_KEY = ['this-computer-report'] as const;

/**
 * This computer's providers as its agent controller last reported them to
 * Switch, or null when it runs no controller with a report. Settings → Agent
 * providers shows this when there is one, so it says what switch-buddy and
 * the New agent form say; Console's own check is the fallback.
 */
export function useThisComputerReport() {
  return useQuery<ThisComputerReport | null>({
    queryKey: THIS_COMPUTER_REPORT_KEY,
    queryFn: () => rpc.managedAgents.thisComputerProviders(),
    staleTime: 10_000,
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
