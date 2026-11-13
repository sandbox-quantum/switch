import { describe, expect, it } from 'vitest';
import { homeChips } from './home-chips';
import { type HomeStateInputs, homeState } from './home-state';

const ready: HomeStateInputs = {
  hostBlocked: false,
  stopped: false,
  unreachable: false,
  signedIn: true,
  aiConnected: true,
  suggestionsReady: true,
};

describe('homeState', () => {
  it('asks switch-buddy when signed in with AI connected', () => {
    expect(homeState(ready)).toBe('askBuddy');
  });

  it('puts an unreachable host, a stopped server and an unreachable gateway first', () => {
    expect(homeState({ ...ready, hostBlocked: true, stopped: true })).toBe('hostUnreachable');
    expect(homeState({ ...ready, stopped: true, unreachable: true })).toBe('stopped');
    expect(homeState({ ...ready, unreachable: true, signedIn: false })).toBe('unreachable');
  });

  it('shows sign-in before anything about AI', () => {
    expect(homeState({ ...ready, signedIn: false, aiConnected: null })).toBe('signedOut');
  });

  it('loads while the status, the AI check or the suggestions are not known', () => {
    expect(homeState({ ...ready, signedIn: null })).toBe('loading');
    expect(homeState({ ...ready, aiConnected: null })).toBe('loading');
    expect(homeState({ ...ready, suggestionsReady: false })).toBe('loading');
  });

  it('offers to connect AI without waiting for suggestions it will not show', () => {
    expect(homeState({ ...ready, aiConnected: false, suggestionsReady: false })).toBe('connectAi');
  });
});

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
