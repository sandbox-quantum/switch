import { fetchBridges, updateBridge } from '@main/core/switch-servers/gateway-client';
import { log } from '@main/lib/logger';
import {
  ambiguousBundledBridgeMessage,
  bundledMattermostBridge,
} from '@shared/core/switch-servers/bundled-bridge';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Point the local server's bundled Mattermost bridge at the addresses that
 * work from this machine, before the seeder runs: the seeder sets the address
 * only when it first registers the bridge, and a server moved off Docker
 * carries one under the compose network's name for Mattermost, which the
 * server then refuses as unresolvable. A server with no bridge yet has nothing
 * to point — the seeder registers it with the right address.
 *
 * Only the bundled bridge is touched: a Mattermost the user connected
 * themselves keeps its own address. When the bundled one cannot be told apart
 * from the others nothing is changed, and the seeder, which applies the same
 * rule, logs why and adopts none of them.
 */
export async function pointBundledMattermostBridgeAt(
  server: SwitchServer,
  url: string,
  callbackBaseUrl: string
): Promise<void> {
  const choice = bundledMattermostBridge(await fetchBridges(server));
  if (choice.kind === 'none') return;
  if (choice.kind === 'ambiguous') {
    log.warn(
      `local-switch-server: not updating the bundled Mattermost bridge's address. ${ambiguousBundledBridgeMessage(choice.bridgeIds)}`
    );
    return;
  }
  await updateBridge(server, choice.bridge.id, {
    connectionConfig: { url, callback_base_url: callbackBaseUrl },
  });
}
