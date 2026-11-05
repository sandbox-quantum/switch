/**
 * Whether people can be invited to a bridged room from Switch, and when not,
 * why — in words the room's settings can show instead of the button.
 *
 * Group and direct-message channels have a fixed membership on every platform,
 * managed on the platform itself (the gateway says the same). Telegram's Bot API
 * has no call that adds a member to a chat at all: people join from a Telegram
 * client or an invite link. Every other platform takes the invite, with its own
 * limits the server reports per person (a Discord public channel needs no
 * invite; a Teams channel needs its team known).
 */
export function roomInviteability(
  room: {
    bridgeId: string | null;
    bridgeType: string | null;
    channelType: string | null;
  },
  platform: string
): { canInvite: true } | { canInvite: false; reason: string | null } {
  if (room.bridgeId === null) return { canInvite: false, reason: null };
  if (room.channelType === 'group' || room.channelType === 'direct') {
    const kind = room.channelType === 'direct' ? 'direct message' : 'group chat';
    return {
      canInvite: false,
      reason: `Who is in this ${kind} is managed in ${platform}.`,
    };
  }
  if (room.bridgeType === 'telegram') {
    return {
      canInvite: false,
      reason: 'Telegram does not let Switch add people. They join from Telegram or an invite link.',
    };
  }
  return { canInvite: true };
}
