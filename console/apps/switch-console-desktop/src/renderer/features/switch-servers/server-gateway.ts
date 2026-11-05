import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { localServerStore } from './local-server-store';

/**
 * Whether a server serves its web gateway — the workspace and server settings
 * Console links out to. Every server does except a Switch this Console runs
 * without Docker: switch-core runs there without the gateway's pages, so its
 * address serves the API alone.
 */
export function servesWebGateway(
  server: Pick<SwitchServer, 'managed' | 'managementKind'>
): boolean {
  return !(server.managed && server.managementKind === 'local' && localServerStore.isNative);
}
