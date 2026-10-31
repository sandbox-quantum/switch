import { browserUrlForChannelLink } from '@shared/core/switch-rooms/channel-links';
import type { RemoteBridge } from '@shared/core/switch-servers/switch-servers';

/**
 * Put each bridge's workspace link in web form, for the same reason the
 * per-room channel action does: Slack describes a workspace with a link only
 * its desktop app answers, so without that app installed the button does
 * nothing at all.
 */
export function withResolvedHomeUrls(bridges: RemoteBridge[]): RemoteBridge[] {
  return bridges.map((bridge) => {
    if (!bridge.homeUrl) return bridge;

    const webUrl = browserUrlForChannelLink(bridge.homeUrl);
    return webUrl ? { ...bridge, homeUrl: webUrl } : bridge;
  });
}
