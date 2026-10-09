import { describe, expect, it } from 'vitest';
import {
  chatRowLabel,
  listingAgents,
  sidebarAgents,
} from '@renderer/features/chats/sidebar-agents';
import type { ChatSummary } from '@shared/core/chats/chats';

const chat = (agents: ChatSummary['agents']) => ({ agents }) as ChatSummary;
const agent = (id: string, name: string, displayName: string | null = null) => ({
  id,
  name,
  displayName,
  iconUrl: null,
  provider: null,
});

describe('sidebarAgents', () => {
  it('lists chat agents and owned agents once each, by name', () => {
    expect(
      sidebarAgents(
        [chat([agent('b', 'bravo')]), chat([agent('b', 'bravo'), agent('c', 'charlie', 'Cee')])],
        [agent('a', 'alpha'), agent('b', 'bravo')]
      ).map((each) => each.name)
    ).toEqual(['alpha', 'bravo', 'Cee']);
  });
});

const summary = (overrides: Partial<ChatSummary>): ChatSummary => ({
  roomId: 'r',
  name: 'Chat with helper',
  channelType: 'direct',
  bridgeType: null,
  channelName: null,
  agents: [],
  canManage: false,
  ownsAgent: false,
  lastMessage: null,
  ...overrides,
});

describe('listingAgents', () => {
  const channel = summary({
    agents: [agent('mine', 'mine'), agent('theirs', 'theirs')],
    ownsAgent: true,
  });

  it('lists a room the person owns an agent in under their own agents only', () => {
    expect(listingAgents(channel, new Set(['mine'])).map((each) => each.id)).toEqual(['mine']);
    expect(sidebarAgents([channel], [agent('mine', 'mine')]).map((each) => each.id)).toEqual([
      'mine',
    ]);
  });

  it('lists it under every agent until their agents are known', () => {
    expect(listingAgents(channel, new Set()).map((each) => each.id)).toEqual(['mine', 'theirs']);
  });

  it('lists any other chat under every agent in it', () => {
    const invited = { ...channel, ownsAgent: false };
    expect(listingAgents(invited, new Set(['mine'])).map((each) => each.id)).toEqual([
      'mine',
      'theirs',
    ]);
  });
});

describe('chatRowLabel', () => {
  it('names a messaging-app channel by its channel, with the app', () => {
    expect(
      chatRowLabel(
        summary({
          name: 'Acme: general',
          channelType: 'channel_public',
          bridgeType: 'slack',
          channelName: 'general',
        })
      )
    ).toEqual({ name: '#general', platform: 'Slack' });
  });

  it('names a messaging-app DM without a hash', () => {
    expect(
      chatRowLabel(summary({ name: 'DM with Dana', bridgeType: 'discord', channelName: 'Dana' }))
    ).toEqual({ name: 'Dana', platform: 'Discord' });
  });

  it('names an internal chat by its own name', () => {
    expect(chatRowLabel(summary({}))).toEqual({ name: 'Chat with helper', platform: null });
  });
});
