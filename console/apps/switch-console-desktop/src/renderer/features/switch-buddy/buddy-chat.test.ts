import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents-key';
import type { ChatAgent } from '@shared/core/chats/chats';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { cachedOwnAgents, isBuddyChat } from './buddy-chat';

const BUDDY_RUN = { id: 'official:switch-buddy', key: 'buddy', revision: 1 };

function chatAgent(patch: Partial<ChatAgent> & { id: string }): ChatAgent {
  return {
    name: patch.id,
    displayName: null,
    iconUrl: null,
    provider: 'claude',
    alias: null,
    ownerName: 'Max',
    ownedByViewer: true,
    ...patch,
  };
}

function own(
  agentId: string,
  name: string,
  template: ManagedAgentView['template'] = null
): Pick<ManagedAgentView, 'agentId' | 'name' | 'template'> {
  return { agentId, name, template };
}

describe('isBuddyChat', () => {
  it('is a chat whose one agent is the person’s own buddy, by the template run that made it', () => {
    const chat = { agents: [chatAgent({ id: 'a1', name: 'helper' })] };
    // Renamed since: the template run decides, not the name.
    expect(isBuddyChat(chat, [own('a1', 'helper', BUDDY_RUN)])).toBe(true);
    // Named like one, made by another template.
    const lookalike = { agents: [chatAgent({ id: 'a2', name: 'switch-buddy-max' })] };
    expect(
      isBuddyChat(lookalike, [
        own('a2', 'switch-buddy-max', { id: 'official:team', key: 'buddy', revision: 1 }),
      ])
    ).toBe(false);
  });

  it('reads the chat’s own record when the person’s agents are not known', () => {
    expect(isBuddyChat({ agents: [chatAgent({ id: 'a1', name: 'switch-buddy-max' })] }, [])).toBe(
      true
    );
    // Someone else's buddy is never the person's.
    expect(
      isBuddyChat(
        { agents: [chatAgent({ id: 'a1', name: 'switch-buddy-ana', ownedByViewer: false })] },
        []
      )
    ).toBe(false);
    expect(isBuddyChat({ agents: [chatAgent({ id: 'a1', name: 'helper' })] }, [])).toBe(false);
  });

  it('is not a chat with no agent, several, or one not known yet', () => {
    const buddy = chatAgent({ id: 'a1', name: 'switch-buddy-max' });
    expect(isBuddyChat(undefined, [])).toBe(false);
    expect(isBuddyChat({ agents: [] }, [])).toBe(false);
    expect(
      isBuddyChat({ agents: [buddy, chatAgent({ id: 'a2', name: 'helper' })] }, [
        own('a1', 'switch-buddy-max', BUDDY_RUN),
      ])
    ).toBe(false);
  });
});

describe('cachedOwnAgents', () => {
  it('takes this user’s lists from every workspace on the server, and nobody else’s', () => {
    const client = new QueryClient();
    const mine = { agentId: 'a1', name: 'switch-buddy-max', template: BUDDY_RUN };
    const otherWorkspace = { agentId: 'a2', name: 'helper', template: null };
    client.setQueryData([MANAGED_AGENTS_KEY, 'server-1', 'ws-1', 'user-1'], [mine]);
    client.setQueryData([MANAGED_AGENTS_KEY, 'server-1', 'ws-2', 'user-1'], [otherWorkspace]);
    client.setQueryData(
      [MANAGED_AGENTS_KEY, 'server-1', 'ws-1', 'user-2'],
      [{ agentId: 'a3', name: 'switch-buddy-ana', template: BUDDY_RUN }]
    );
    client.setQueryData(
      [MANAGED_AGENTS_KEY, 'server-2', 'ws-1', 'user-1'],
      [{ agentId: 'a4', name: 'elsewhere', template: null }]
    );
    // A server running no agent management answers null.
    client.setQueryData([MANAGED_AGENTS_KEY, 'server-1', 'ws-3', 'user-1'], null);
    // Not a list, under the same prefix.
    client.setQueryData([MANAGED_AGENTS_KEY, 'server-1', 'machine-recheck', 'user-1'], {
      state: 'done',
    });

    expect(cachedOwnAgents(client, 'server-1', 'user-1').map((agent) => agent.agentId)).toEqual(
      expect.arrayContaining(['a1', 'a2'])
    );
    expect(cachedOwnAgents(client, 'server-1', 'user-1')).toHaveLength(2);
    expect(cachedOwnAgents(client, 'server-1', null)).toEqual([]);
  });
});
