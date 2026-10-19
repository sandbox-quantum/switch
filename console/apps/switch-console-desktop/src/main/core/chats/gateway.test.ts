import { describe, expect, it, vi } from 'vitest';
import { gatewayFetch } from '@main/core/switch-servers/gateway-client';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { parseChatRows, warmChatAgent } from './gateway';

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
