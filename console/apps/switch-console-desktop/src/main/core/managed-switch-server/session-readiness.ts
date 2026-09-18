import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { localServerService } from './local-server-service';
import { verifySdkCompatibility } from './sdk-compatibility';

export async function ensureServerSessionReady(server: SwitchServer): Promise<void> {
  if (server.managed && server.managementKind !== 'remote') {
    await localServerService.ensureReady();
  }
  await verifySdkCompatibility(server);
}
