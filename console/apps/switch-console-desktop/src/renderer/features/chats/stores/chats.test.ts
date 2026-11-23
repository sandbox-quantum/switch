import { QueryClient } from '@tanstack/react-query';
import { runInAction } from 'mobx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSummary } from '@shared/core/chats/chats';
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
    statusFor: () => ({ user: { id: 'user-1' } }),
    isConnected: () => true,
    refreshStatus: async () => {},
  },
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: {
    activeServerId: null,
    active: null,
    idOnServerInScope: (serverId: string | null) => (serverId ? `${serverId}-ws` : null),
  },
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
const { rememberBuddyChat } = await import('@renderer/features/switch-buddy/buddy-chat');

const BUDDY_RUN = { id: 'official:switch-buddy', key: 'buddy', revision: 1 };

function chat(
  roomId: string,
  channelType: ChatSummary['channelType'],
  agents: { id: string; name: string }[]
): ChatSummary {
  return chatSummarySchema.parse({
    roomId,
    name: 'Welcome',
    channelType,
    bridgeType: null,
    channelName: null,
    agents: agents.map((agent) => ({
      displayName: null,
      iconUrl: null,
      provider: null,
      ownedByViewer: true,
      ...agent,
    })),
    canManage: true,
    lastMessage: null,
  });
}

async function sendIn(serverId: string, roomId: string): Promise<Record<string, unknown>> {
  calls.get('chats.send')?.mockClear();
  chatsStore.timelines.get(serverId, roomId).send({
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
  beforeEach(() => {
    runInAction(() => {
      chatsStore.serverId = 'server-1';
    });
    const queryClient = client.current as QueryClient;
    queryClient.clear();
    queryClient.setQueryData(
      [MANAGED_AGENTS_KEY, 'server-1', 'server-1-ws', 'user-1'],
      [{ agentId: 'buddy', name: 'helper', template: BUDDY_RUN }]
    );
  });

  it('says a message in the person’s direct chat with their buddy is to their buddy', async () => {
    chatsStore.add('server-1', chat('room-buddy', 'direct', [{ id: 'buddy', name: 'helper' }]));

    expect(await sendIn('server-1', 'room-buddy')).toMatchObject({
      serverId: 'server-1',
      roomId: 'room-buddy',
      body: 'hello',
      toBuddy: true,
    });
  });

  it('says a group chat, another agent’s chat or a chat it does not know is not', async () => {
    chatsStore.add('server-1', chat('room-group', 'group', [{ id: 'buddy', name: 'helper' }]));
    chatsStore.add('server-1', chat('room-other', 'direct', [{ id: 'other', name: 'reviewer' }]));

    expect(await sendIn('server-1', 'room-group')).toMatchObject({ toBuddy: false });
    expect(await sendIn('server-1', 'room-other')).toMatchObject({ toBuddy: false });
    expect(await sendIn('server-1', 'room-unknown')).toMatchObject({ toBuddy: false });
  });

  it('counts the buddy’s chat on a server the chats list does not follow', async () => {
    rememberBuddyChat('server-2', 'room-elsewhere', 'buddy-2', Date.now());

    expect(await sendIn('server-2', 'room-elsewhere')).toMatchObject({
      serverId: 'server-2',
      toBuddy: true,
    });
    // The same room id on the followed server is another chat.
    expect(await sendIn('server-1', 'room-elsewhere')).toMatchObject({ toBuddy: false });
  });
});
