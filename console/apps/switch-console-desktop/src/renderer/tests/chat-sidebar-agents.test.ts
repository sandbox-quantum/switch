import { describe, expect, it } from 'vitest';
import { sidebarAgents } from '@renderer/features/chats/sidebar-agents';
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
