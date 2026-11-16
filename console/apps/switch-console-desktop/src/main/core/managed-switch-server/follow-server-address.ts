import { propagateServerApiUrl } from '@main/core/agents/propagate-server-api-url';
import { embeddedControllerService } from '@main/core/embedded-controller/embedded-controllers';
import { log } from '@main/lib/logger';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * A managed server's record now has a different address than before its
 * start — its ports were picked again, or it moved from `localhost` to the
 * `127.0.0.1` it is reached at now. Point its agents and this computer's
 * controller at the new one, as editing a server's address does; until they
 * follow, they go on calling the old one.
 */
export async function followManagedServerAddress(
  previousUrl: string | null,
  server: SwitchServer
): Promise<void> {
  if (previousUrl === null || previousUrl === server.url) return;
  log.info('managed-switch-server: the server address changed; moving its agents to it', {
    serverId: server.id,
    from: previousUrl,
    to: server.url,
  });
  const results = await propagateServerApiUrl(server.id, server.url);
  const failed = results.filter((result) => result.outcome === 'failed');
  if (failed.length > 0) {
    log.error('managed-switch-server: some agents still point at the old server address', {
      serverId: server.id,
      agents: failed.map((result) => result.agentName),
    });
  }
  await embeddedControllerService.followServerApiUrl(server.id);
}
