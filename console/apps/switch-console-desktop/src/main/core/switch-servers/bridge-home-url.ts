import { LOCAL_SERVER_MATTERMOST_TEAM } from '@main/core/managed-switch-server/constants';
import { mattermostOriginFor } from '@main/core/switch-rooms/mattermost-origin';
import { browserUrlForChannelLink } from '@shared/core/switch-rooms/channel-links';
import type { RemoteBridge, SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Resolve the link that opens each bridge's workspace, preferring one
 * Switch Console can reach over one the server merely knows about.
 *
 * The gateway builds `home_url` from the bridge's connection config, which is
 * right for Slack, Discord and Teams — public platforms whose URLs are the
 * same everywhere. It is *wrong* for a managed stack's bundled Mattermost: the
 * configured `url` is the in-compose `http://mattermost:8065`, unreachable from
 * the user's machine, and `public_url` is unset because the deployment does not
 * know which port Switch Console published it on. Switch Console does know, so it
 * substitutes its own origin.
 *
 * That substitution is also why the action works before the gateway gains the
 * field at all: for the common case — a managed server's bundled Mattermost —
 * nothing here depends on the server's answer.
 *
 * Every remaining link is put in web form for the same reason the per-room
 * channel action is: Slack and Mattermost describe a workspace with a link only
 * their desktop app answers, so without that app installed the button does
 * nothing at all.
 */
export async function withResolvedHomeUrls(
  server: SwitchServer,
  bridges: RemoteBridge[]
): Promise<RemoteBridge[]> {
  const localTeamUrl = await localMattermostTeamUrl(server, bridges);

  return bridges.map((bridge) => {
    if (bridge.type === 'mattermost' && localTeamUrl) {
      return { ...bridge, homeUrl: localTeamUrl };
    }
    if (!bridge.homeUrl) return bridge;

    const webUrl = browserUrlForChannelLink(bridge.homeUrl, null);
    return webUrl ? { ...bridge, homeUrl: webUrl } : bridge;
  });
}

/**
 * The bundled Mattermost's team page on the origin switchdash published it on,
 * or null when this is not a managed stack we run and know the ports of.
 */
async function localMattermostTeamUrl(
  server: SwitchServer,
  bridges: RemoteBridge[]
): Promise<string | null> {
  if (!server.managed || !bridges.some((b) => b.type === 'mattermost')) return null;

  const origin = await mattermostOriginFor(server.id);
  return origin ? `${origin}/${LOCAL_SERVER_MATTERMOST_TEAM}` : null;
}
