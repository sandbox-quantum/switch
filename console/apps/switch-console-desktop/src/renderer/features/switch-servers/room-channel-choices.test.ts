import { describe, expect, it } from 'vitest';
import { channelChoiceCards, optionsForBridge } from './room-channel-choices';
import { DEFAULT_ROOM_OPTIONS } from './room-create-request';

const bridge = (type: string, channelIdsRefused: string | null = null) => ({
  type,
  displayName: `Acme ${type}`,
  channelIdsRefused,
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

  it('leaves out a private channel on Teams, which Switch cannot make there', () => {
    expect(channelChoiceCards(bridge('teams')).map((card) => card.value)).toEqual([
      'public',
      'existing',
    ]);
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
