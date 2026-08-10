import { appService } from '@main/core/app/service';
import { browserUrlForChannelLink } from '@shared/core/switch-rooms/channel-links';
import { mattermostOriginFor } from './mattermost-origin';

/**
 * Open a room's bridged channel outside Switch Console.
 *
 * The gateway describes a channel with the link its platform prefers, which for
 * Mattermost and Slack is one only their desktop app answers. Handing that
 * straight to the OS is what made the channel action do nothing on a machine
 * without the app, so translate it to the web address for the same channel
 * first — see {@link browserUrlForChannelLink}.
 *
 * Lives in the main process because the origin a managed stack's Mattermost is
 * published on is only known here.
 *
 * Throws when the channel cannot be opened, so the caller can say so. A link
 * that opens nothing is the failure this exists to stop repeating.
 */
export async function openRoomChannel(params: {
  serverId: string;
  channelUrl: string;
}): Promise<void> {
  const { serverId, channelUrl } = params;

  const mattermostOrigin = channelUrl.startsWith('mattermost://')
    ? await mattermostOriginFor(serverId)
    : null;

  const target = browserUrlForChannelLink(channelUrl, mattermostOrigin);
  if (!target) {
    throw new Error(`No web address is known for this channel link: ${channelUrl}`);
  }

  await appService.openExternal(target);
}
