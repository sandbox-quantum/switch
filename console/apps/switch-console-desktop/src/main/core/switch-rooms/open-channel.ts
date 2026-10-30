import { appService } from '@main/core/app/service';
import { browserUrlForChannelLink } from '@shared/core/switch-rooms/channel-links';

/**
 * Open a room's bridged channel outside Switch Console.
 *
 * The gateway describes a channel with the link its platform prefers, which for
 * Slack is one only its desktop app answers. Handing that straight to the OS is
 * what made the channel action do nothing on a machine without the app, so
 * translate it to the web address for the same channel first — see
 * {@link browserUrlForChannelLink}.
 *
 * Throws when the channel cannot be opened, so the caller can say so. A link
 * that opens nothing is the failure this exists to stop repeating.
 */
export async function openRoomChannel(channelUrl: string): Promise<void> {
  const target = browserUrlForChannelLink(channelUrl);
  if (!target) {
    throw new Error(`No web address is known for this channel link: ${channelUrl}`);
  }

  await appService.openExternal(target);
}
