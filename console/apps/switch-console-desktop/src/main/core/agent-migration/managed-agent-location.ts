import { embeddedControllerService } from '@main/core/embedded-controller/embedded-controllers';
import type { TelemetryLocationKind } from '@main/core/telemetry/events';

/**
 * Where a managed agent runs, as `agent_created` reports it: `local` when its
 * machine is the controller this computer is enrolled as on the server,
 * `remote` for any other machine — an SSH host, a cloud machine, someone's
 * other computer.
 *
 * Best effort, like the platform lookups beside other reports: it only
 * describes an agent that already exists, so a lookup that fails reports
 * `unknown` rather than failing anything.
 */
export async function managedAgentLocation(
  serverId: string,
  controllerId: string
): Promise<TelemetryLocationKind> {
  try {
    const thisComputer = await embeddedControllerService.enrolledControllerId(serverId);
    return thisComputer === controllerId ? 'local' : 'remote';
  } catch {
    return 'unknown';
  }
}
