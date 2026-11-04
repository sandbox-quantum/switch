import type { RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import type { RoomCreateOptions } from './room-create-request';

export type ChannelChoice = 'public' | 'private' | 'existing';

export type ChannelChoiceCard = { value: ChannelChoice; title: string; detail: string };

/**
 * What a new public and a new private channel are on each platform, as its
 * adapter makes them. Worded per platform because they differ: a Discord
 * channel is read without joining it, and a private one there is hidden by
 * permission rather than by membership, so its server's admins still see it.
 *
 * `private` is null where Switch cannot make a private channel. On Teams an
 * app must name an owner when it creates one, and Switch does not, so the
 * choice is left out rather than offered and refused.
 */
const NEW_CHANNEL: Record<string, { public: string; private: string | null }> = {
  slack: {
    public: 'Anyone in the Slack workspace can find and join it.',
    private: 'Only people invited to it can see it.',
  },
  mattermost: {
    public: 'Anyone in the team can find and join it.',
    private: 'Only people added to it can see it.',
  },
  discord: {
    public: 'Everyone in the server can see and read it.',
    private: 'Hidden from everyone but the people given access and the server’s admins.',
  },
  teams: {
    public: 'A standard channel: everyone in the team can see it.',
    private: null,
  },
};

/** Any other platform: said without promising what its channels do. */
const OTHER = {
  public: 'A public channel on this messaging app.',
  private: 'A private channel on this messaging app.',
};

/**
 * The channel choices for a new room on `bridge`, each saying what it means
 * there: a new public channel first (the server's default), a new private one
 * where the platform has one Switch can make, and an existing channel where
 * the app lets a channel be named by its id.
 */
export function channelChoiceCards(
  bridge: Pick<RemoteBridge, 'type' | 'displayName' | 'channelIdsRefused'>
): ChannelChoiceCard[] {
  const known = NEW_CHANNEL[bridge.type] ?? OTHER;
  return [
    { value: 'public', title: 'New public channel', detail: known.public },
    ...(known.private !== null
      ? [{ value: 'private' as const, title: 'New private channel', detail: known.private }]
      : []),
    ...(bridge.channelIdsRefused === null
      ? [
          {
            value: 'existing' as const,
            title: 'Existing channel',
            detail: `Use a channel already in ${bridge.displayName}, by its id.`,
          },
        ]
      : []),
  ];
}

/** `options` with its channel choice kept only if `bridge` offers it. */
export function optionsForBridge(
  options: RoomCreateOptions,
  bridge: Pick<RemoteBridge, 'type' | 'displayName' | 'channelIdsRefused'> | null
): RoomCreateOptions {
  if (bridge === null) return options;
  const offered = new Set(channelChoiceCards(bridge).map((card) => card.value));
  const choice =
    options.channel.kind === 'existing'
      ? 'existing'
      : options.channel.private
        ? 'private'
        : 'public';
  return offered.has(choice) ? options : { ...options, channel: { kind: 'new', private: false } };
}
