// What deleting a room says about its platform channel. Worded as Switch
// Console's room delete dialog words it, so the two say the same thing.

import type { ChannelRetirement, RetireOutcome } from "../../data/api";

/** The outcomes a person can opt into: the channel is kept unless they ask,
 * and these are the platforms where asking does something. */
export type RetirableChannel = Exclude<ChannelRetirement, "kept">;

/** Whether deleting the room can also retire its channel. Teams (`kept`) and
 * a room with no channel (`null`) have nothing to offer. */
export function isRetirable(outcome: ChannelRetirement | null): outcome is RetirableChannel {
  return outcome === "archived" || outcome === "deleted" || outcome === "left";
}

export function retireChannelLabel(platform: string, outcome: RetirableChannel): string {
  switch (outcome) {
    case "archived":
      return `Also archive the ${platform} channel`;
    case "deleted":
      return `Also delete the ${platform} channel`;
    case "left":
      return `Also have the bot leave the ${platform} chat`;
  }
}

/** What becomes of the channel when it is kept, the default: a room is often
 * deleted to take the agents out of a channel people keep using. */
export function channelKeptText(platform: string, outcome: ChannelRetirement): string {
  if (outcome === "kept") return `Its ${platform} channel stays in ${platform}; remove it there.`;
  const where = outcome === "left" ? "chat" : "channel";
  return `The ${platform} ${where} stays as it is; Switch stops syncing it.`;
}

/** What retiring the channel will do, once the person has asked for it. */
export function channelRetiredText(platform: string, outcome: RetirableChannel): string {
  switch (outcome) {
    case "archived":
      return `Its ${platform} channel will be archived.`;
    case "deleted":
      return `Its ${platform} channel will be deleted.`;
    case "left":
      return `The bot will leave the ${platform} chat; the chat itself stays.`;
  }
}

/** The notice for a channel the server could not retire, or null when there
 * is nothing to clean up. The room is gone by then, so this says only what is
 * left to do by hand, and why. */
export function channelCleanupText(
  platform: string,
  planned: RetirableChannel,
  channel: RetireOutcome | null,
): string | null {
  if (channel?.outcome !== "failed") return null;
  const why = channel.reason ? ` (${channel.reason})` : "";
  switch (planned) {
    case "archived":
      return `The room was deleted, but its ${platform} channel could not be archived${why}. Archive it in ${platform} by hand.`;
    case "deleted":
      return `The room was deleted, but its ${platform} channel could not be deleted${why}. Delete it in ${platform} by hand.`;
    case "left":
      return `The room was deleted, but the bot could not leave the ${platform} chat${why}. Remove the bot from the chat in ${platform}.`;
  }
}
