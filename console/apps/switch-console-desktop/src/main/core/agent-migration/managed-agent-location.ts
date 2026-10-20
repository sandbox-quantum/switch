import { embeddedControllerService } from '@main/core/embedded-controller/embedded-controllers';
import type { TelemetryLocationKind } from '@main/core/telemetry/events';
import { log } from '@main/lib/logger';

/**
 * Tells where managed agents on `serverId` run, as `agent_created` reports it,
 * from one read of which controller this computer is enrolled as: `local` for
 * an agent on that controller, `remote` for any other machine — an SSH host, a
 * cloud machine, someone's other computer.
 *
 * Best effort, like the platform lookups beside other reports: it only
 * describes agents that already exist, so a read that fails tells `unknown`
 * for every agent, and says so in the log, rather than failing anything.
 */
export async function managedAgentLocator(
  serverId: string
): Promise<(controllerId: string) => TelemetryLocationKind> {
  try {
    const thisComputer = await embeddedControllerService.enrolledControllerId(serverId);
    return (controllerId) => (thisComputer === controllerId ? 'local' : 'remote');
  } catch (error) {
    log.warn('Could not tell whether managed agents run on this computer; reporting unknown', {
      event: 'telemetry_managed_agent_location',
      error: String(error),
    });
    return () => 'unknown';
  }
}
