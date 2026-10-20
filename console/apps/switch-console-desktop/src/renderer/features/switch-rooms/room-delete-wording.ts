import type { ChannelRetirement, RetireOutcome } from '@shared/core/switch-servers/switch-servers';

/** The outcomes a person can opt into when deleting a room: the channel is kept
 * unless they ask, and these are the platforms where asking does something. */
export type RetirableChannel = Exclude<ChannelRetirement, 'kept'>;

/** Whether deleting the room can also retire its channel, and so whether the
 * delete dialog offers the choice. Teams (`kept`), no channel (`null`) and a
 * server predating the field (`undefined`) have nothing to offer. */
export function isRetirable(
  outcome: ChannelRetirement | null | undefined
): outcome is RetirableChannel {
  return outcome === 'archived' || outcome === 'deleted' || outcome === 'left';
}

/** The label of the delete dialog's opt-in for retiring the channel. */
export function retireChannelLabel(platform: string, outcome: RetirableChannel): string {
  switch (outcome) {
    case 'archived':
      return `Also archive the ${platform} channel`;
    case 'deleted':
      return `Also delete the ${platform} channel`;
    case 'left':
      return `Also have the bot leave the ${platform} chat`;
  }
}

/** What becomes of a retirable channel when the person leaves it be — the
 * default, since a room is often deleted to take the agents out of a channel
 * people keep using. */
export function channelKeptText(platform: string, outcome: RetirableChannel): string {
  const where = outcome === 'left' ? 'chat' : 'channel';
  return `The ${platform} ${where} stays as it is; Switch stops syncing it.`;
}

/**
 * What retiring the room's channel on `platform` does, as the server says that
 * platform's bridge will — said in the delete dialog once the person has asked
 * for it, and for Teams, where the channel always stays.
 *
 * Null when the room has no channel. Undefined — a server predating the field,
 * which never touches the channel — gets the one thing that is true everywhere:
 * the channel may still be there afterwards. Never says a channel is deleted
 * unless it will be.
 */
export function channelOnDeleteText(
  platform: string,
  outcome: ChannelRetirement | null | undefined
): string | null {
  switch (outcome) {
    case null:
      return null;
    case undefined:
      return `The ${platform} channel may remain after the room is deleted.`;
    case 'archived':
      return `Its ${platform} channel will be archived.`;
    case 'deleted':
      return `Its ${platform} channel will be deleted.`;
    case 'left':
      return `The bot will leave the ${platform} chat; the chat itself stays.`;
    case 'kept':
      return `Its ${platform} channel stays in ${platform}; remove it there.`;
  }
}

/**
 * The room settings page's one line on the channel, before anyone has chosen:
 * kept unless they ask for more in the delete dialog.
 */
export function channelOnDeleteSummary(
  platform: string,
  outcome: ChannelRetirement | null | undefined
): string | null {
  switch (outcome) {
    case 'archived':
      return `Its ${platform} channel is kept unless you choose to archive it.`;
    case 'deleted':
      return `Its ${platform} channel is kept unless you choose to delete it.`;
    case 'left':
      return `The bot stays in the ${platform} chat unless you choose to have it leave.`;
    default:
      return channelOnDeleteText(platform, outcome);
  }
}

/**
 * The notice for a channel the server could not retire, or null when there is
 * nothing to clean up. The room is gone by then, so this only says what is left
 * for the person to do by hand, and why. Only a channel someone asked to retire
 * can fail: a kept one comes back null.
 */
export function channelCleanupText(
  platform: string,
  planned: ChannelRetirement | null | undefined,
  channel: RetireOutcome | null
): string | null {
  if (channel?.outcome !== 'failed') return null;
  const why = channel.reason ? ` (${channel.reason})` : '';
  switch (planned) {
    case 'archived':
      return `The room was deleted, but its ${platform} channel could not be archived${why}. Archive it in ${platform} by hand.`;
    case 'deleted':
      return `The room was deleted, but its ${platform} channel could not be deleted${why}. Delete it in ${platform} by hand.`;
    case 'left':
      return `The room was deleted, but the bot could not leave the ${platform} chat${why}. Remove the bot from the chat in ${platform}.`;
    default:
      return `The room was deleted, but its ${platform} channel was not cleaned up${why}. Remove it in ${platform} by hand.`;
  }
}
