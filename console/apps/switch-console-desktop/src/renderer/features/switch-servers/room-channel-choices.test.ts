import { describe, expect, it } from 'vitest';
import {
  channelChoiceCards,
  optionsForBridge,
  channelIdProblem,
  normalizedChannelId,
} from './room-channel-choices';
import { DEFAULT_ROOM_OPTIONS } from './room-create-request';

// Mattermost's shape (26 lowercase letters and digits), kept low-entropy so it reads as made up.
const MATTERMOST_ID = 'mm' + '0'.repeat(24);

const bridge = (
  type: string,
  channelIdsRefused: string | null = null,
  privateChannels: boolean | null = null,
  privateChannelNeedsLinkedAccount = false
) => ({
  type,
  displayName: `Acme ${type}`,
  channelIdsRefused,
  privateChannels,
  privateChannelNeedsLinkedAccount,
});

describe('the channel choices for a new room', () => {
  it('offers a public, a private and an existing channel, saying what each is on Slack', () => {
    const cards = channelChoiceCards(bridge('slack'));
    expect(cards.map((card) => card.value)).toEqual(['public', 'private', 'existing']);
    expect(cards[0]!.detail).toBe('Anyone in the Slack workspace can find and join it.');
    expect(cards[1]!.detail).toBe('Only people invited to it can see it.');
    expect(cards[2]!.detail).toBe('Use a channel already in Acme slack, by its id.');
  });

  it('says a Discord channel is read without joining, and a private one still shows to its admins', () => {
    const [publicCard, privateCard] = channelChoiceCards(bridge('discord'));
    expect(publicCard!.detail).toBe('Everyone in the server can see and read it.');
    expect(privateCard!.detail).toContain('the server’s admins');
  });

  it('offers a private channel where the server says it can make one, Teams included', () => {
    const cards = channelChoiceCards(bridge('teams', null, true, true), true);
    expect(cards.map((card) => card.value)).toEqual(['public', 'private', 'existing']);
    expect(cards[1]!.detail).toBe('Only people added to it can see it.');
  });

  it('asks for a linked account only from someone who has none where one is needed', () => {
    const teams = bridge('teams', null, true, true);
    expect(channelChoiceCards(teams, false)[1]!.detail).toBe(
      'Only people added to it can see it. Link your Acme teams account first: Acme teams needs you as its owner.'
    );
    // Elsewhere the account is how Switch puts them in it.
    expect(channelChoiceCards(bridge('slack', null, true, true), false)[1]!.detail).toBe(
      'Only people invited to it can see it. Link your Acme slack account first, so Switch can add you to it.'
    );
    // Not while the answer is unknown, and never where no account is needed.
    expect(channelChoiceCards(teams, null)[1]!.detail).toBe('Only people added to it can see it.');
    expect(channelChoiceCards(bridge('slack', null, true), false)[1]!.detail).toBe(
      'Only people invited to it can see it.'
    );
  });

  it('leaves out a private channel where the server says it cannot make one', () => {
    expect(channelChoiceCards(bridge('slack', null, false)).map((card) => card.value)).toEqual([
      'public',
      'existing',
    ]);
  });

  it('leaves out a private channel on Teams for a server that does not say, which cannot make one', () => {
    expect(channelChoiceCards(bridge('teams')).map((card) => card.value)).toEqual([
      'public',
      'existing',
    ]);
    expect(channelChoiceCards(bridge('slack')).map((card) => card.value)).toContain('private');
  });

  it('leaves out an existing channel where the app cannot be pointed at one by id', () => {
    expect(
      channelChoiceCards(bridge('slack', 'Add the app to the channel.')).map((card) => card.value)
    ).toEqual(['public', 'private']);
  });

  it('promises nothing about a platform it does not know', () => {
    expect(channelChoiceCards(bridge('carrier-pigeon'))[0]!.detail).toBe(
      'A public channel on this messaging app.'
    );
  });
});

describe('keeping the channel choice to what the app offers', () => {
  const privateChoice = {
    ...DEFAULT_ROOM_OPTIONS,
    channel: { kind: 'new' as const, private: true },
  };

  it('keeps a choice the app offers', () => {
    expect(optionsForBridge(privateChoice, bridge('slack'))).toBe(privateChoice);
  });

  it('falls back to a new public channel when the app does not offer the choice', () => {
    expect(optionsForBridge(privateChoice, bridge('teams')).channel).toEqual({
      kind: 'new',
      private: false,
    });
  });
});

describe('channelIdProblem', () => {
  it('accepts an id of each platform’s shape', () => {
    expect(channelIdProblem('slack', 'C0123ABCD')).toBeNull();
    expect(channelIdProblem('slack', 'G01ABCDEF')).toBeNull();
    expect(channelIdProblem('mattermost', MATTERMOST_ID)).toBeNull();
    expect(channelIdProblem('discord', '1234567890123456789')).toBeNull();
    expect(channelIdProblem('teams', '19:a1b2c3d4e5f6@thread.tacv2')).toBeNull();
  });

  it('says where to find the id when it is not of the shape', () => {
    expect(channelIdProblem('slack', '#general')).toMatch(/starts with C or G/);
    expect(channelIdProblem('mattermost', 'town-square')).toMatch(/View Info/);
    expect(channelIdProblem('discord', 'general')).toMatch(/Copy Channel ID/);
    expect(channelIdProblem('teams', '19%3aabc%40thread.tacv2')).toMatch(/%3a/);
  });

  it('takes a Slack id with no digits as pasted, but not a channel’s name typed in lower case', () => {
    expect(channelIdProblem('slack', 'CABCDEFGHJ')).toBeNull();
    expect(channelIdProblem('slack', 'general')).toMatch(/starts with C or G/);
    expect(channelIdProblem('slack', 'cabcdefghj')).toMatch(/starts with C or G/);
  });

  it('takes an id differing only in case or surrounding space as meant', () => {
    expect(channelIdProblem('slack', '  c0123abcd ')).toBeNull();
    expect(normalizedChannelId('slack', '  c0123abcd ')).toBe('C0123ABCD');
    expect(normalizedChannelId('mattermost', MATTERMOST_ID.toUpperCase())).toBe(MATTERMOST_ID);
    // Teams ids are left as pasted, but for the space around them.
    expect(normalizedChannelId('teams', ' 19:AbC@thread.tacv2 ')).toBe('19:AbC@thread.tacv2');
  });

  it('says nothing for a blank id or a platform it does not know', () => {
    expect(channelIdProblem('slack', '  ')).toBeNull();
    expect(channelIdProblem('zulip', 'anything')).toBeNull();
  });
});
