import { expect, it } from 'vitest';
import { inAppRooms } from './room-apps';

it('keeps only the rooms on no messaging app, in their order', () => {
  const rooms = [
    { id: 'a', bridgeType: 'slack' },
    { id: 'b', bridgeType: null },
    { id: 'c', bridgeType: 'teams' },
    { id: 'd', bridgeType: null },
  ];
  expect(inAppRooms(rooms).map((room) => room.id)).toEqual(['b', 'd']);
});
