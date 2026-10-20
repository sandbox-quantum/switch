import { embeddedControllerService } from '@main/core/embedded-controller/embedded-controllers';
import type { TelemetryLocationKind } from '@main/core/telemetry/events';
import { log } from '@main/lib/logger';

/**
 * Where managed agents on `serverId` run, from one read of this computer's
 * enrollment: `local` on its controller, `remote` elsewhere, `unknown` (logged)
 * when the read fails.
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
