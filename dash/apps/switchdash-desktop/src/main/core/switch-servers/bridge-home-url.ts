import { LOCAL_SERVER_MATTERMOST_TEAM } from '@main/core/managed-switch-server/constants';
import { mattermostOriginFor } from '@main/core/switch-rooms/mattermost-origin';
import type { RemoteBridge, SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Resolve the link that opens each bridge's workspace, preferring one
 * switchdash can reach over one the server merely knows about.
 *
 * The gateway builds `home_url` from the bridge's connection config, which is
 * right for Slack, Discord and Teams — public platforms whose URLs are the
 * same everywhere. It is *wrong* for a managed stack's bundled Mattermost: the
 * configured `url` is the in-compose `http://mattermost:8065`, unreachable from
 * the user's machine, and `public_url` is unset because the deployment does not
 * know which port switchdash published it on. switchdash does know, so it
 * substitutes its own origin.
 *
 * That substitution is also why the action works before the gateway gains the
 * field at all: for the common case — a managed server's bundled Mattermost —
 * nothing here depends on the server's answer.
 */
export async function withResolvedHomeUrls(
  server: SwitchServer,
  bridges: RemoteBridge[]
): Promise<RemoteBridge[]> {
  if (!server.managed || !bridges.some((b) => b.type === 'mattermost')) {
    return bridges;
  }

  const origin = await mattermostOriginFor(server.id);
  if (!origin) return bridges;

  const localTeamUrl = `${origin}/${LOCAL_SERVER_MATTERMOST_TEAM}`;
  return bridges.map((bridge) =>
    bridge.type === 'mattermost' ? { ...bridge, homeUrl: localTeamUrl } : bridge
  );
}
