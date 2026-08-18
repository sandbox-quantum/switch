import { describe, expect, it } from 'vitest';
import { membershipSummary, roomTitle } from './room-labels';

describe('roomTitle', () => {
  it('marks a bridged room as the channel it is', () => {
    expect(roomTitle({ name: 'louis-dev', bridgeType: 'mattermost' })).toBe('#louis-dev');
  });

  it('leaves a room in no messaging app alone — there is no channel to name', () => {
    expect(roomTitle({ name: 'louis-dev', bridgeType: null })).toBe('louis-dev');
  });

  it('does not double the sigil on a name that already carries one', () => {
    expect(roomTitle({ name: '#general', bridgeType: 'slack' })).toBe('#general');
  });
});

describe('membershipSummary', () => {
  it('counts agents and people separately', () => {
    expect(membershipSummary(1, 1)).toBe('1 agent · 1 person');
    expect(membershipSummary(3, 2)).toBe('3 agents · 2 people');
  });

  it('omits people rather than reporting none', () => {
    expect(membershipSummary(2, 0)).toBe('2 agents');
  });

  it('says an empty room has no agents rather than saying nothing', () => {
    expect(membershipSummary(0, 0)).toBe('0 agents');
  });
});
