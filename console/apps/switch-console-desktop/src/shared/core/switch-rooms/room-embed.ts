/**
 * How a room's conversation is shown inside Switch Console, when it is not a
 * Console chat: rooms bridged to an external platform are opened there.
 */
export type RoomEmbed =
  /** Offer the deeplink into the platform the room is bridged to. */
  | { kind: 'external'; url: string; platform: string }
  /** Nothing to show, with a reason worth surfacing rather than a blank pane. */
  | { kind: 'unavailable'; reason: string }
  /**
   * Bridged to a platform that cannot be embedded, with no link to open it at.
   * Carries the platform key rather than a sentence, so the renderer names it
   * the way the server describes it.
   */
  | { kind: 'unlinked'; platform: string };

export function resolveRoomEmbed(
  bridgeType: string | null,
  externalChannelUrl: string | null
): RoomEmbed {
  if (!bridgeType) {
    return {
      kind: 'unavailable',
      reason:
        "This chat can't be opened here: you may not be a member of it, or chats are turned off on this server.",
    };
  }
  if (externalChannelUrl)
    return { kind: 'external', url: externalChannelUrl, platform: bridgeType };
  return { kind: 'unlinked', platform: bridgeType };
}
