import { describe, expect, it } from 'vitest';
import { resolveRoomEmbed } from './room-embed';

describe('resolveRoomEmbed', () => {
  it('says a room with no bridge has no channel', () => {
    expect(resolveRoomEmbed(null, null).kind).toBe('unavailable');
  });

  it('offers the link into the platform a room is bridged to', () => {
    expect(resolveRoomEmbed('slack', 'slack://channel?id=C1')).toEqual({
      kind: 'external',
      url: 'slack://channel?id=C1',
      platform: 'slack',
    });
  });

  it('names the platform when there is no link to open', () => {
    expect(resolveRoomEmbed('discord', null)).toEqual({ kind: 'unlinked', platform: 'discord' });
  });
});
