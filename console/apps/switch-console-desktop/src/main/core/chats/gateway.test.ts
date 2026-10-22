import { describe, expect, it, vi } from 'vitest';
import { gatewayFetch } from '@main/core/switch-servers/gateway-client';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import {
  addChatAgent,
  addChatMember,
  createChat,
  fetchThreadMessages,
  listWorkspaceMembers,
  listAgentCandidates,
  parseChatRows,
  removeChatAgent,
  sendChatMessage,
  warmChatAgent,
} from './gateway';

const warn = vi.hoisted(() => vi.fn());
vi.mock('@main/lib/logger', () => ({ log: { warn } }));
vi.mock('@main/core/switch-servers/gateway-client', () => ({
  GatewayError: class extends Error {},
  gatewayFetch: vi.fn(),
}));

function row(roomId: string, channelType: string) {
  return {
    roomId,
    name: roomId,
    channelType,
    bridgeType: null,
    channelName: null,
    agents: [],
    canManage: true,
    ownsAgent: false,
    memberUserIds: [],
    memberCount: 0,
    lastMessage: null,
  };
}

describe('parseChatRows', () => {
  it('accepts every channel type the server sends', () => {
    const types = ['lobby', 'channel_public', 'channel_private', 'group', 'direct'];
    expect(parseChatRows(types.map((type) => row(type, type))).map((c) => c.roomId)).toEqual(types);
  });

  it('skips a row that fails the contract with a warning and keeps the rest', () => {
    const chats = parseChatRows([row('room-a', 'direct'), row('room-bad', 'unknown')]);
    expect(chats.map((chat) => chat.roomId)).toEqual(['room-a']);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ roomId: 'room-bad' })
    );
  });
});

describe('warmChatAgent', () => {
  it('posts the agent to the room’s warm route', async () => {
    const server = { id: 'server-1' } as SwitchServer;
    vi.mocked(gatewayFetch).mockResolvedValueOnce(new Response(null, { status: 202 }));
    await warmChatAgent(server, 'room/a', 'agent-1');
    expect(gatewayFetch).toHaveBeenCalledWith(server, '/chats/room%2Fa/warm', {
      authenticated: true,
      method: 'POST',
      body: { agentId: 'agent-1' },
    });
  });
});

describe('createChat', () => {
  it('creates chat with zero agents and memberUserIds', async () => {
    const server = { id: 'server-1' } as SwitchServer;
    vi.mocked(gatewayFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ chat: row('room-new', 'group') }), { status: 200 })
    );
    await createChat(server, {
      agentIds: [],
      memberUserIds: ['user-1', 'user-2'],
      name: 'Test Group',
      requestId: 'req-1',
      greeting: null,
    });
    expect(gatewayFetch).toHaveBeenCalledWith(server, '/chats', {
      authenticated: true,
      method: 'POST',
      body: {
        requestId: 'req-1',
        agentIds: [],
        memberUserIds: ['user-1', 'user-2'],
        name: 'Test Group',
      },
    });
  });

  it('creates chat with one agent using agentId field', async () => {
    const server = { id: 'server-1' } as SwitchServer;
    vi.mocked(gatewayFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ chat: row('room-new', 'direct') }), { status: 200 })
    );
    await createChat(server, {
      agentIds: ['agent-1'],
      name: null,
      requestId: 'req-1',
      greeting: null,
    });
    expect(gatewayFetch).toHaveBeenCalledWith(server, '/chats', {
      authenticated: true,
      method: 'POST',
      body: { requestId: 'req-1', agentId: 'agent-1' },
    });
  });

  it('asks for a group of one agent when kind is group', async () => {
    const server = { id: 'server-1' } as SwitchServer;
    vi.mocked(gatewayFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ chat: row('room-new', 'channel_private') }), { status: 200 })
    );
    await createChat(server, {
      agentIds: ['agent-1'],
      memberUserIds: [],
      name: 'Solo',
      requestId: 'req-1',
      greeting: null,
      kind: 'group',
    });
    expect(gatewayFetch).toHaveBeenCalledWith(server, '/chats', {
      authenticated: true,
      method: 'POST',
      body: {
        requestId: 'req-1',
        agentId: 'agent-1',
        memberUserIds: [],
        name: 'Solo',
        kind: 'group',
      },
    });
  });
});

describe('addChatAgent', () => {
  it('posts agent to the chat agents route', async () => {
    const server = { id: 'server-1' } as SwitchServer;
    vi.mocked(gatewayFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ chat: row('room-1', 'group') }), { status: 200 })
    );
    await addChatAgent(server, 'room-1', 'agent-2');
    expect(gatewayFetch).toHaveBeenCalledWith(server, '/chats/room-1/agents', {
      authenticated: true,
      method: 'POST',
      body: { agentId: 'agent-2' },
    });
  });
});

describe('removeChatAgent', () => {
  it('deletes agent from the chat', async () => {
    const server = { id: 'server-1' } as SwitchServer;
    vi.mocked(gatewayFetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await removeChatAgent(server, 'room-1', 'agent-2');
    expect(gatewayFetch).toHaveBeenCalledWith(server, '/chats/room-1/agents/agent-2', {
      authenticated: true,
      method: 'DELETE',
    });
  });
});

describe('chat members', () => {
  it('adds a person and answers with the members', async () => {
    const server = { id: 'server-1' } as SwitchServer;
    vi.mocked(gatewayFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ members: [{ userId: 'u2', name: 'Bob', isOwner: false }] }), {
        status: 200,
      })
    );
    expect(await addChatMember(server, 'room-1', 'u2')).toEqual([
      { userId: 'u2', name: 'Bob', isOwner: false },
    ]);
    expect(gatewayFetch).toHaveBeenCalledWith(server, '/chats/room-1/members', {
      authenticated: true,
      method: 'POST',
      body: { userId: 'u2' },
    });
  });

  it('reads the workspace roster in its snake_case shape', async () => {
    const server = { id: 'server-1' } as SwitchServer;
    vi.mocked(gatewayFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { user_id: 'u2', name: 'Bob', email: null, role: 'member' },
          { user_id: 'u3', name: 'Bot', email: null, role: 'member', service_account: true },
        ]),
        { status: 200 }
      )
    );
    expect(await listWorkspaceMembers(server, 't-1')).toEqual([
      { userId: 'u2', name: 'Bob', email: null, serviceAccount: false },
      { userId: 'u3', name: 'Bot', email: null, serviceAccount: true },
    ]);
    expect(gatewayFetch).toHaveBeenCalledWith(server, '/tenants/t-1/members', {
      authenticated: true,
    });
  });
});

describe('sendChatMessage', () => {
  it('sends message with mentionAgentIds', async () => {
    const server = { id: 'server-1' } as SwitchServer;
    vi.mocked(gatewayFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [] }), { status: 200 })
    );
    await sendChatMessage(server, 'room-1', {
      requestId: 'req-1',
      body: 'Test message',
      threadRootId: null,
      uploadIds: [],
      mentionAgentIds: ['agent-1', 'agent-2'],
    });
    expect(gatewayFetch).toHaveBeenCalledWith(server, '/chats/room-1/messages', {
      authenticated: true,
      method: 'POST',
      body: {
        requestId: 'req-1',
        body: 'Test message',
        threadRootId: null,
        uploadIds: [],
        mentionAgentIds: ['agent-1', 'agent-2'],
      },
    });
  });
});

describe('fetchThreadMessages', () => {
  it('fetches thread messages with pagination', async () => {
    const server = { id: 'server-1' } as SwitchServer;
    vi.mocked(gatewayFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [], headSeq: 100, hasMore: false }), { status: 200 })
    );
    await fetchThreadMessages(server, 'room-1', 'msg-root', { beforeSeq: 50, limit: 20 });
    expect(gatewayFetch).toHaveBeenCalledWith(
      server,
      '/chats/room-1/threads/msg-root/messages?limit=20&beforeSeq=50',
      { authenticated: true }
    );
  });
});

describe('listAgentCandidates', () => {
  it('asks for a new chat without a room and for a chat with its id', async () => {
    const server = { id: 'server-1' } as SwitchServer;
    vi.mocked(gatewayFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ agentIds: ['a1'] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ agentIds: [] }), { status: 200 }));
    expect(await listAgentCandidates(server, null)).toEqual(['a1']);
    expect(await listAgentCandidates(server, 'room 1')).toEqual([]);
    expect(gatewayFetch).toHaveBeenCalledWith(server, '/chats/agent-candidates', {
      authenticated: true,
    });
    expect(gatewayFetch).toHaveBeenCalledWith(server, '/chats/agent-candidates?roomId=room%201', {
      authenticated: true,
    });
  });
});
