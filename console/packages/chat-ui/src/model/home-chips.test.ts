import { describe, expect, it } from 'vitest';
import { homeChips } from './home-chips';

describe('homeChips', () => {
  const settled = { hasMessagingApp: true, isAdmin: true, otherAgentCount: 2, otherRoomCount: 2 };

  it('shows the defaults for a workspace already set up', () => {
    expect(homeChips(settled)).toEqual(['new_room', 'new_agent', 'room_instructions']);
  });

  it('offers a messaging app only to an admin', () => {
    expect(homeChips({ ...settled, hasMessagingApp: false })[0]).toBe('connect_chat_app');
    expect(homeChips({ ...settled, hasMessagingApp: false, isAdmin: false })).not.toContain(
      'connect_chat_app'
    );
  });

  it('drops the default that says the same as a first-time suggestion', () => {
    expect(homeChips({ ...settled, otherAgentCount: 0 })).toEqual([
      'first_agent',
      'new_room',
      'room_instructions',
    ]);
    expect(homeChips({ ...settled, otherRoomCount: 0 })).toEqual([
      'team_room',
      'new_agent',
      'room_instructions',
    ]);
  });

  it('shows at most three, the conditional ones first', () => {
    expect(
      homeChips({ hasMessagingApp: false, isAdmin: true, otherAgentCount: 0, otherRoomCount: 0 })
    ).toEqual(['connect_chat_app', 'first_agent', 'team_room']);
  });
});
