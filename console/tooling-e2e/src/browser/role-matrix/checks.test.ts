import { describe, expect, it } from 'vitest';
import { landingOf } from './checks.ts';

describe('landingOf', () => {
  const routing = new Set(['decision_routing']);
  const none = new Set<string>();

  it('tells whoever may open a page that needs a flag the server has off that it is not turned on', () => {
    expect(landingOf('workspaceAdmin', '/settings/message-routing', none).state).toBe(
      'not-enabled'
    );
    expect(landingOf('workspaceAdmin', '/settings/message-routing', routing).state).toBe('page');
    expect(landingOf('member', '/settings/message-routing', none).state).toBe('refused');
  });

  it('follows a room and an agent into Chats', () => {
    expect(landingOf('member', '/rooms/:roomId', none).path).toBe('/chats/rooms/:roomId');
    expect(landingOf('member', '/agents/:agentId', none)).toMatchObject({
      path: '/chats/agents/:agentId',
      query: null,
    });
  });

  it('expects New room open, and its parameter gone from the address', () => {
    expect(landingOf('member', '/rooms/new', none)).toEqual({
      path: '/chats',
      query: 'tab=rooms',
      state: 'page',
      dialog: { param: 'new', title: 'New room' },
    });
  });
});
