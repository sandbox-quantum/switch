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
 * Whether a private channel is offered at all is the server's answer
 * (`RemoteBridge.privateChannels`); this only says what one is.
 */
const NEW_CHANNEL: Record<string, { public: string; private: string }> = {
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
    private: 'Only people added to it can see it.',
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
type ChoiceBridge = Pick<
  RemoteBridge,
  | 'type'
  | 'displayName'
  | 'channelIdsRefused'
  | 'privateChannels'
  | 'privateChannelNeedsLinkedAccount'
>;

/**
 * Whether `bridge` can make a private channel. The server says; a server
 * predating the answer could on every platform but Teams, where it named no
 * owner and Microsoft refused.
 */
function offersPrivateChannel(bridge: ChoiceBridge): boolean {
  return bridge.privateChannels ?? bridge.type !== 'teams';
}

export function channelChoiceCards(
  bridge: ChoiceBridge,
  linkedHere: boolean | null = null
): ChannelChoiceCard[] {
  const known = NEW_CHANNEL[bridge.type] ?? OTHER;
  // Said only to someone who has no confirmed account linked here, the one case
  // where the private channel would be refused. Not while the answer is still
  // unknown: a warning on a list that has not arrived is a false alarm.
  const privateDetail =
    bridge.privateChannelNeedsLinkedAccount && linkedHere === false
      ? `${known.private} ${linkFirst(bridge)}`
      : known.private;
  return [
    { value: 'public', title: 'New public channel', detail: known.public },
    ...(offersPrivateChannel(bridge)
      ? [{ value: 'private' as const, title: 'New private channel', detail: privateDetail }]
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

/**
 * Why a private channel on `bridge` needs the person's linked account: Teams
 * makes them its owner; anywhere else they are put in it, as nobody else
 * could let them in.
 */
export function linkFirst(bridge: Pick<ChoiceBridge, 'type' | 'displayName'>): string {
  return bridge.type === 'teams'
    ? `Link your ${bridge.displayName} account first: ${bridge.displayName} needs you as its owner.`
    : `Link your ${bridge.displayName} account first, so Switch can add you to it.`;
}

/** `options` with its channel choice kept only if `bridge` offers it. */
export function optionsForBridge(
  options: RoomCreateOptions,
  bridge: ChoiceBridge | null
): RoomCreateOptions {
  if (bridge === null) return options;
  const offered = new Set(channelChoiceCards(bridge).map((card) => card.value));
  return offered.has(channelChoiceOf(options))
    ? options
    : { ...options, channel: { kind: 'new', private: false } };
}

/** The channel choice a set of options holds. */
export function channelChoiceOf(options: RoomCreateOptions): ChannelChoice {
  if (options.channel.kind === 'existing') return 'existing';
  return options.channel.private ? 'private' : 'public';
}

/**
 * What is wrong with `id` as a channel id on `bridgeType`, saying where to
 * find the right one, or null when it has the platform's shape (or the
 * platform is one Console does not know). Checked here because the server
 * reports a malformed id only as a fault: a Discord id that is not a number,
 * say, fails as it is read.
 */
export function channelIdProblem(bridgeType: string, id: string): string | null {
  const value = normalizedChannelId(bridgeType, id);
  if (value === '') return null;
  const shape = CHANNEL_ID_SHAPE[bridgeType];
  if (!shape) return null;
  if (!shape.pattern.test(value)) return shape.problem;
  // Slack ids usually carry digits but need not. One with none is taken only as
  // pasted, in capitals: typed in lower case it is a channel's name ("general").
  if (bridgeType === 'slack' && !/\d/.test(value) && /[a-z]/.test(id)) return shape.problem;
  return null;
}

/**
 * `id` as its app writes it: trimmed, and in the one case its app uses where
 * that is known (Slack ids are upper case, Mattermost's lower), so a pasted
 * id differing only in case or surrounding space is taken as meant.
 */
export function normalizedChannelId(bridgeType: string, id: string): string {
  const value = id.trim();
  if (bridgeType === 'slack') return value.toUpperCase();
  if (bridgeType === 'mattermost') return value.toLowerCase();
  return value;
}

const CHANNEL_ID_SHAPE: Record<string, { pattern: RegExp; problem: string }> = {
  slack: {
    pattern: /^[CG][A-Z0-9]{6,}$/,
    problem:
      'A Slack channel id starts with C or G, like C0123ABCD. It is at the bottom of the channel’s details.',
  },
  mattermost: {
    pattern: /^[a-z0-9]{26}$/,
    problem:
      'A Mattermost channel id is 26 lowercase letters and digits. It is under the channel’s View Info.',
  },
  discord: {
    pattern: /^\d{15,22}$/,
    problem:
      'A Discord channel id is a long number. With Developer Mode on, right-click the channel and choose Copy Channel ID.',
  },
  teams: {
    pattern: /^19:[^\s/?#%@]+@thread\.(?:tacv2|skype)$/,
    problem:
      'A Teams channel id looks like 19:…@thread.tacv2. It is in the channel’s link, where : is written %3a and @ is %40.',
  },
};
