import { describe, expect, it } from 'vitest';
import { roomInviteability } from './room-membership';

const BRIDGED = { bridgeId: 'b-1', channelType: 'channel_public' };

describe('roomInviteability', () => {
  it('invites to a channel on Slack, Mattermost, Discord and Teams', () => {
    for (const bridgeType of ['slack', 'mattermost', 'discord', 'teams']) {
      expect(roomInviteability({ ...BRIDGED, bridgeType }, 'X')).toEqual({ canInvite: true });
    }
  });

  it('says Telegram cannot add people', () => {
    const result = roomInviteability({ ...BRIDGED, bridgeType: 'telegram' }, 'Telegram');
    expect(result.canInvite).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('Telegram') });
  });

  it('leaves a group or direct-message channel’s membership to its platform', () => {
    expect(
      roomInviteability({ bridgeId: 'b-1', bridgeType: 'slack', channelType: 'group' }, 'Slack')
    ).toEqual({ canInvite: false, reason: 'Who is in this group chat is managed in Slack.' });
    expect(
      roomInviteability(
        { bridgeId: 'b-1', bridgeType: 'discord', channelType: 'direct' },
        'Discord'
      )
    ).toEqual({ canInvite: false, reason: 'Who is in this direct message is managed in Discord.' });
  });

  it('has nothing to invite to in a room with no messaging app', () => {
    expect(roomInviteability({ bridgeId: null, bridgeType: null, channelType: null }, '')).toEqual({
      canInvite: false,
      reason: null,
    });
  });
});
