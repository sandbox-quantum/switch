import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { MANAGED_AGENTS_KEY } from '@renderer/features/managed-agents/use-managed-agents-key';
import type { ChatAgent, ChatSummary } from '@shared/core/chats/chats';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import {
  cachedOwnAgents,
  forgetBuddyChat,
  isBuddyChat,
  REMEMBERED_BUDDY_CHAT_MS,
  rememberBuddyChat,
  rememberedBuddy,
} from './buddy-chat';

const BUDDY_RUN = { id: 'official:switch-buddy', key: 'buddy', revision: 1 };
const OTHER_RUN = { id: 'official:team', key: 'buddy', revision: 1 };

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

function direct(...agents: ChatAgent[]): Pick<ChatSummary, 'agents' | 'channelType'> {
  return { channelType: 'direct', agents };
}

function own(
  agentId: string,
  name: string,
  template: ManagedAgentView['template'] = null
): Pick<ManagedAgentView, 'agentId' | 'name' | 'template'> {
  return { agentId, name, template };
}

describe('isBuddyChat', () => {
  it('is a direct chat with the person’s own buddy, by the template run that made it', () => {
    // Renamed since: the template run decides, not the name.
    expect(
      isBuddyChat(
        direct(chatAgent({ id: 'a1', name: 'helper' })),
        [own('a1', 'helper', BUDDY_RUN)],
        null
      )
    ).toBe(true);
    // Named like one, made by another template.
    expect(
      isBuddyChat(
        direct(chatAgent({ id: 'a2', name: 'switch-buddy-max' })),
        [own('a2', 'switch-buddy-max', OTHER_RUN)],
        null
      )
    ).toBe(false);
  });

  it('takes the person’s list as the whole answer once it is read', () => {
    // Theirs and named like a buddy, but not among their managed agents: not their buddy.
    expect(
      isBuddyChat(
        direct(chatAgent({ id: 'a3', name: 'switch-buddy-test' })),
        [own('a1', 'helper', BUDDY_RUN)],
        null
      )
    ).toBe(false);
    expect(isBuddyChat(direct(chatAgent({ id: 'a3', name: 'switch-buddy-test' })), [], null)).toBe(
      false
    );
  });

  it('goes by the chat’s own record of the agent when the list is not read', () => {
    expect(isBuddyChat(direct(chatAgent({ id: 'a1', name: 'switch-buddy-max' })), null, null)).toBe(
      true
    );
    // Someone else's buddy is never the person's.
    expect(
      isBuddyChat(
        direct(chatAgent({ id: 'a1', name: 'switch-buddy-ana', ownedByViewer: false })),
        null,
        null
      )
    ).toBe(false);
    expect(isBuddyChat(direct(chatAgent({ id: 'a1', name: 'helper' })), null, null)).toBe(false);
  });

  it('counts the chat it was opened as, even before the list knows the new buddy', () => {
    expect(isBuddyChat(direct(chatAgent({ id: 'new', name: 'helper' })), [], 'new')).toBe(true);
    // Not held by the chats list (another server, or not caught up): what it was opened as decides.
    expect(isBuddyChat(undefined, null, 'new')).toBe(true);
    expect(isBuddyChat(undefined, [own('a1', 'helper', BUDDY_RUN)], null)).toBe(false);
  });

  it('is never a group chat, or a chat with no agent or several', () => {
    const buddy = chatAgent({ id: 'a1', name: 'switch-buddy-max' });
    const list = [own('a1', 'switch-buddy-max', BUDDY_RUN)];
    // People were added to it: messages there are not only to the buddy.
    expect(isBuddyChat({ channelType: 'group', agents: [buddy] }, list, 'a1')).toBe(false);
    expect(isBuddyChat(direct(), list, null)).toBe(false);
    expect(isBuddyChat(direct(buddy, chatAgent({ id: 'a2', name: 'helper' })), list, 'a1')).toBe(
      false
    );
  });
});

describe('rememberBuddyChat', () => {
  it('remembers the buddy a chat was opened with, by server and room', () => {
    rememberBuddyChat('server-1', 'room-1', 'buddy-1', 1000);
    expect(rememberedBuddy('server-1', 'room-1', 1000)).toBe('buddy-1');
    expect(rememberedBuddy('server-2', 'room-1', 1000)).toBeNull();
    expect(rememberedBuddy('server-1', 'room-2', 1000)).toBeNull();
  });

  it('stops vouching for it after a while, since it may have become a group elsewhere', () => {
    rememberBuddyChat('server-1', 'room-3', 'buddy-1', 1000);
    expect(rememberedBuddy('server-1', 'room-3', 1000 + REMEMBERED_BUDDY_CHAT_MS)).toBe('buddy-1');
    expect(rememberedBuddy('server-1', 'room-3', 1001 + REMEMBERED_BUDDY_CHAT_MS)).toBeNull();
  });

  it('forgets a chat someone was added to', () => {
    rememberBuddyChat('server-1', 'room-4', 'buddy-1', 1000);
    forgetBuddyChat('server-1', 'room-4');
    expect(rememberedBuddy('server-1', 'room-4', 1000)).toBeNull();
  });
});

describe('cachedOwnAgents', () => {
  it('reads only this user’s list for the workspace in scope', () => {
    const client = new QueryClient();
    const mine = { agentId: 'a1', name: 'switch-buddy-max', template: BUDDY_RUN };
    client.setQueryData([MANAGED_AGENTS_KEY, 'server-1', 'ws-1', 'user-1'], [mine]);
    client.setQueryData(
      [MANAGED_AGENTS_KEY, 'server-1', 'ws-2', 'user-1'],
      [{ agentId: 'a2', name: 'helper', template: null }]
    );
    client.setQueryData(
      [MANAGED_AGENTS_KEY, 'server-1', 'ws-1', 'user-2'],
      [{ agentId: 'a3', name: 'switch-buddy-ana', template: BUDDY_RUN }]
    );
    // A list under the same prefix that is not the agents'.
    client.setQueryData([MANAGED_AGENTS_KEY, 'server-1', 'machines', 'user-1'], [{ id: 'm1' }]);

    expect(cachedOwnAgents(client, 'server-1', 'ws-1', 'user-1')).toEqual([mine]);
    expect(cachedOwnAgents(client, 'server-2', 'ws-1', 'user-1')).toBeNull();
    expect(cachedOwnAgents(client, 'server-1', null, 'user-1')).toBeNull();
    expect(cachedOwnAgents(client, 'server-1', 'ws-1', null)).toBeNull();
  });

  it('is null for a server without agent management, which answers null', () => {
    const client = new QueryClient();
    client.setQueryData([MANAGED_AGENTS_KEY, 'server-1', 'ws-1', 'user-1'], null);
    expect(cachedOwnAgents(client, 'server-1', 'ws-1', 'user-1')).toBeNull();
  });
});
