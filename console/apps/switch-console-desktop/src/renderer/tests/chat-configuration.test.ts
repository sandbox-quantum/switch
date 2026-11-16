import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { chatMembersQueryKey } from '@renderer/features/chats/chat-people';
import {
  addAllToChat,
  addLabel,
  addToChat,
  ChatAddParticipantPanel,
  InviteHint,
} from '@renderer/features/switch-rooms/room-add-participants';
import { RoomConfigurationPanel } from '@renderer/features/switch-rooms/room-configuration-panel';
import { RoomSidePanel } from '@renderer/features/switch-rooms/room-side-panel';
import type { ChatSummary } from '@shared/core/chats/chats';
import { RpcError } from '@shared/lib/ipc/rpc-error';

const chat = vi.hoisted(() => ({ current: null as ChatSummary | null }));
vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {} }));
vi.mock('@renderer/features/chats/stores/chats', () => ({
  chatsStore: {
    serverId: 's',
    removed: new Set(),
    chat: () => chat.current ?? undefined,
    add: vi.fn(),
  },
}));

const showModal = vi.hoisted(() => vi.fn());
const flags = vi.hoisted(() => ({ group_chats: true }));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({ useFeatureFlags: () => flags }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => showModal }));

const agent = {
  id: 'agent-1',
  name: 'helper',
  displayName: 'Helper',
  iconUrl: null,
  provider: null,
  alias: null,
  ownerName: null,
  ownedByViewer: false,
};

function render(canManage: boolean, panel: 'side' | 'configuration' | 'add' = 'side'): string {
  chat.current = {
    roomId: 'r',
    name: 'Planning',
    channelType: 'channel_private',
    bridgeType: null,
    channelName: null,
    agents: [agent],
    canManage,
    ownsAgent: false,
    memberUserIds: ['u1', 'u2'],
    memberCount: 2,
    unreadCount: 0,
    lastMessage: null,
  };
  const client = new QueryClient();
  client.setQueryData(chatMembersQueryKey('s', chat.current), [
    { userId: 'u1', name: 'Alice', isOwner: true },
    { userId: 'u2', name: 'Bob', isOwner: false },
  ]);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      panel === 'side'
        ? createElement(RoomSidePanel, { roomId: 'r' })
        : panel === 'configuration'
          ? createElement(RoomConfigurationPanel, { roomId: 'r' })
          : createElement(ChatAddParticipantPanel, {
              serverId: 's',
              workspaceId: null,
              chat: chat.current,
              memberIds: new Set(['u1', 'u2']),
              onAddedPeople: () => {},
            })
    )
  );
}

describe('a group chat’s participant column', () => {
  it('lists the chat’s agents and people, with adding and a menu per member for a manager', () => {
    const html = render(true);
    expect(html).toContain('Helper');
    expect(html).toContain('Bob');
    // Its own button, not the + beside Agents, which reads as agents only.
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>).)*Add participants<\/button>/);
    expect(html).not.toContain('aria-label="Add agents"');
    expect(html).not.toContain('aria-label="Add people"');
    expect(html).toContain('aria-label="Helper in this room"');
    expect(html).toContain('aria-label="Bob in this room"');
    // The owner stays: there is no one to hand the chat to.
    expect(html).not.toContain('aria-label="Alice in this room"');
  });

  it('offers no adding to a manager while the server does not offer group chats', () => {
    flags.group_chats = false;
    try {
      const html = render(true);
      expect(html).not.toContain('Add participants');
      expect(html).toContain('aria-label="Bob in this room"');
    } finally {
      flags.group_chats = true;
    }
  });

  it('shows the participants without controls to someone who cannot manage', () => {
    const html = render(false);
    expect(html).toContain('Bob');
    expect(html).not.toContain('Add participants');
    expect(html).not.toContain('in this room"');
  });
});

describe('adding to a group chat', () => {
  it('puts the invite line under the field, and holds Add until someone is picked', () => {
    const html = render(true, 'add');
    const field = html.indexOf('id="chat-add-participant"');
    expect(field).toBeGreaterThan(-1);
    expect(html.indexOf('Don&#x27;t see someone?')).toBeGreaterThan(field);
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*><span[^>]*>Add<span data-slot="shortcut"/);
  });
});

describe('a group chat’s configuration', () => {
  it('leaves who is in the chat to the participant column, and keeps Leave room', () => {
    const html = render(false, 'configuration');
    expect(html).not.toContain('Group chat in Switch Console');
    expect(html).not.toContain('id="chat-add-participant"');
    // Leaving needs no manager rights.
    expect(html).toContain('Leave room…');
  });
});

describe('chatMembersQueryKey', () => {
  it('reads the members again on an add, a removal or a swap, not on a new message', () => {
    render(true);
    const base = chat.current!;
    const key = (memberUserIds: string[], extra: Partial<ChatSummary> = {}) =>
      chatMembersQueryKey('s', {
        ...base,
        memberUserIds,
        memberCount: memberUserIds.length,
        unreadCount: 0,
        ...extra,
      });
    const now = key(['u1', 'u2']);
    expect(key(['u1', 'u2', 'u3'])).not.toEqual(now);
    expect(key(['u1'])).not.toEqual(now);
    expect(key(['u1', 'u3'])).not.toEqual(now);
    expect(
      key(['u1', 'u2'], { lastMessage: { seq: 9, sentAt: '', preview: 'hi', senderName: 'Bob' } })
    ).toEqual(now);
  });
});

describe('group chat people', () => {
  it('labels the owner, and nobody else', () => {
    const html = render(false);
    expect(html).toMatch(/Alice<\/span><span[^>]*>owner</);
    expect(html).not.toMatch(/Bob<\/span><span[^>]*>/);
    expect(html).not.toContain('>person<');
  });

  it('offers the invite to someone who may invite, and says who to ask otherwise', () => {
    const can = renderToStaticMarkup(
      createElement(InviteHint, { workspaceId: 'w', canInvite: true })
    );
    expect(can).toContain('Invite them to the workspace');
    expect(can).toContain('<button');
    const cannot = renderToStaticMarkup(
      createElement(InviteHint, { workspaceId: 'w', canInvite: false })
    );
    expect(cannot).toContain('Ask a workspace admin to invite them.');
    expect(cannot).not.toContain('<button');
  });
});

describe('addToChat', () => {
  it('adds an agent to the chat and a person as a member', async () => {
    const api = {
      addAgent: vi.fn(async () => chat.current!),
      addMember: vi.fn(async () => [{ userId: 'u2', name: 'Bob', isOwner: false }]),
    };
    const agentPick = {
      kind: 'agent' as const,
      id: 'a1',
      name: 'helper',
      iconUrl: null,
      detail: 'Agent · Claude Code',
    };
    render(true);
    expect((await addToChat(api, 's', 'r', agentPick)).kind).toBe('agent');
    expect(api.addAgent).toHaveBeenCalledWith({ serverId: 's', roomId: 'r', agentId: 'a1' });
    const added = await addToChat(api, 's', 'r', {
      kind: 'person',
      id: 'u2',
      name: 'Bob',
      detail: 'bob@example.com',
    });
    expect(added).toEqual({
      kind: 'person',
      members: [{ userId: 'u2', name: 'Bob', isOwner: false }],
    });
    expect(api.addMember).toHaveBeenCalledWith({ serverId: 's', roomId: 'r', userId: 'u2' });
  });
});

describe('adding the picked participants', () => {
  const agentPick = {
    kind: 'agent' as const,
    id: 'a1',
    name: 'helper',
    iconUrl: null,
    detail: 'Agent · Claude Code',
  };
  const refusedPick = { ...agentPick, id: 'a2', name: 'agent-b' };
  const bobPick = { kind: 'person' as const, id: 'u2', name: 'Bob', detail: 'bob@example.com' };

  it('counts the picks on the button', () => {
    expect(addLabel(0)).toBe('Add');
    expect(addLabel(1)).toBe('Add');
    expect(addLabel(3)).toBe('Add 3');
  });

  it('adds every pick and gives back only the refused ones, with the reason', async () => {
    render(true);
    const api = {
      addAgent: vi.fn(async ({ agentId }: { agentId: string }) => {
        if (agentId === 'a2')
          throw new RpcError({
            __switchConsoleRpcError: true,
            code: 'ChatApiError',
            message: 'You may not chat with this agent here.',
            data: { apiCode: 'AGENT_NOT_ALLOWED', status: 403 },
          });
        return chat.current!;
      }),
      addMember: vi.fn(async () => [{ userId: 'u2', name: 'Bob', isOwner: false }]),
    };
    const onAdded = vi.fn();
    const failures = await addAllToChat(api, 's', 'r', [agentPick, refusedPick, bobPick], onAdded);
    expect(api.addAgent).toHaveBeenCalledTimes(2);
    expect(api.addMember).toHaveBeenCalledWith({ serverId: 's', roomId: 'r', userId: 'u2' });
    expect(onAdded).toHaveBeenCalledTimes(2);
    expect(failures).toEqual([
      { participant: refusedPick, reason: 'You may not chat with this agent here.' },
    ]);
  });
});
