import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { localServerStore } from './local-server-store';

type ServerKind = Pick<SwitchServer, 'managed' | 'managementKind'>;

/**
 * Whether a server serves its web gateway — the workspace and server settings
 * Console links out to. Every server does except a Switch this Console runs
 * without Docker that is not serving the gateway's pages: one started without
 * them (by an older Console, or where they could not be built), or one not
 * seen running yet.
 */
export function servesWebGateway(server: ServerKind): boolean {
  return !localServerStore.lacksAdminPages(server);
}

/**
 * Whether a server would serve its web gateway after a restart: this
 * machine's native server, started without the pages by an older Console,
 * now that this one has them to give it.
 */
export function webGatewayNeedsRestart(server: ServerKind): boolean {
  return localServerStore.lacksAdminPages(server) && localServerStore.adminPages === 'restart';
}
