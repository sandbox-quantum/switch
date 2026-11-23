import { QueryClient } from '@tanstack/react-query';
import { runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import { chatSummarySchema } from '@shared/core/chats/chats';

const calls = vi.hoisted(() => new Map<string, ReturnType<typeof vi.fn>>());
const client = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@renderer/lib/ipc', () => {
  const method = (name: string) => {
    if (!calls.has(name))
      calls.set(
        name,
        vi.fn(async () => (name === 'chats.send' ? [] : null))
      );
    return calls.get(name)!;
  };
  const namespace = (ns: string) =>
    new Proxy({}, { get: (_, key) => method(`${ns}.${String(key)}`) });
  return {
    rpc: new Proxy({}, { get: (_, ns) => namespace(String(ns)) }),
    events: { on: () => () => {} },
  };
});
vi.mock('@renderer/lib/query-client', () => ({
  get queryClient() {
    return client.current;
  },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: {
    statusFor: (serverId: string) => (serverId === 'server-1' ? { user: { id: 'user-1' } } : null),
    isConnected: () => true,
    refreshStatus: async () => {},
  },
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { activeServerId: null, active: null },
}));
vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: { refreshRoomState: async () => {} },
}));
vi.mock('./activities', () => ({ agentActivities: { feedState: () => {} } }));
vi.mock('./agent-chats-flag', () => ({ agentChatsFlag: () => null }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: () => {} } }));

client.current = new QueryClient();
const { chatsStore } = await import('./chats');
const { MANAGED_AGENTS_KEY } =
  await import('@renderer/features/managed-agents/use-managed-agents-key');

function chat(roomId: string, agents: { id: string; name: string; ownedByViewer: boolean }[]) {
  return chatSummarySchema.parse({
    roomId,
    name: 'Welcome',
    channelType: 'direct',
    bridgeType: null,
    channelName: null,
    agents: agents.map((agent) => ({ displayName: null, iconUrl: null, provider: null, ...agent })),
    canManage: true,
    lastMessage: null,
  });
}

async function sendIn(roomId: string): Promise<Record<string, unknown>> {
  const send = calls.get('chats.send');
  send?.mockClear();
  chatsStore.timelines.get('server-1', roomId).send({
    body: 'hello',
    threadRootId: null,
    mentionAgentIds: [],
    mentionUserIds: [],
    mentionSpans: [],
    files: [],
    requestId: null,
  });
  await vi.waitFor(() => expect(calls.get('chats.send')).toHaveBeenCalledTimes(1));
  return calls.get('chats.send')!.mock.calls[0]![0] as Record<string, unknown>;
}

describe('the chats store’s send', () => {
  runInAction(() => {
    chatsStore.serverId = 'server-1';
  });
  (client.current as QueryClient).setQueryData(
    [MANAGED_AGENTS_KEY, 'server-1', 'ws-1', 'user-1'],
    [
      {
        agentId: 'buddy',
        name: 'helper',
        template: { id: 'official:switch-buddy', key: 'buddy', revision: 1 },
      },
    ]
  );

  it('says a message in a chat with the person’s own buddy is to their buddy', async () => {
    chatsStore.add(
      'server-1',
      chat('room-buddy', [{ id: 'buddy', name: 'helper', ownedByViewer: true }])
    );

    expect(await sendIn('room-buddy')).toMatchObject({
      serverId: 'server-1',
      roomId: 'room-buddy',
      body: 'hello',
      toBuddy: true,
    });
  });

  it('says any other chat is not, and so is one it does not know', async () => {
    chatsStore.add(
      'server-1',
      chat('room-other', [{ id: 'other', name: 'reviewer', ownedByViewer: true }])
    );

    expect(await sendIn('room-other')).toMatchObject({ roomId: 'room-other', toBuddy: false });
    expect(await sendIn('room-unknown')).toMatchObject({ roomId: 'room-unknown', toBuddy: false });
  });
});
