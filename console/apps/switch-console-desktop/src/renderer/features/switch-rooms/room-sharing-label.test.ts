import { describe, expect, it } from 'vitest';
import { roomSharingLabel } from './room-sharing-label';

const names: Record<string, string> = { hub: 'switch-dev', a: 'work-a', b: 'work-b' };
const name = (id: string) => names[id] ?? id;

describe('roomSharingLabel', () => {
  const sharing = { homeRoomId: 'hub', sharedRoomIds: ['a', 'b'] };

  it('says the session is based here, in the home room', () => {
    expect(roomSharingLabel(sharing, 'hub', name)).toBe(
      'Shared session, based here · 3 rooms'
    );
  });

  it('names the home room from a room that shares it', () => {
    expect(roomSharingLabel(sharing, 'a', name)).toBe(
      'Shared session, based in switch-dev · 3 rooms'
    );
  });

  it('says nothing for an isolated room, or an agent that shares no session', () => {
    expect(roomSharingLabel(sharing, 'side', name)).toBeNull();
    expect(roomSharingLabel({ homeRoomId: null, sharedRoomIds: [] }, 'hub', name)).toBeNull();
    expect(roomSharingLabel(undefined, 'hub', name)).toBeNull();
  });

  it('counts one room when only home shares it', () => {
    expect(roomSharingLabel({ homeRoomId: 'hub', sharedRoomIds: [] }, 'hub', name)).toBe(
      'Shared session, based here · 1 room'
    );
  });
});
