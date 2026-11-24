import { QueryClient } from '@tanstack/react-query';
import { runInAction } from 'mobx';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
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

const BUDDY_RUN = { id: 'official:switch-buddy', key: 'buddy', revision: 1 };

/** The mocked RPC method, made on first use like the mock itself does. */
function method(name: string): Mock<(...args: string[]) => Promise<unknown>> {
  if (!calls.has(name))
    calls.set(
      name,
      vi.fn(async () => null)
    );
  return calls.get(name) as Mock<(...args: string[]) => Promise<unknown>>;
}

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
      toBuddy: 'yes',
    });
  });

  it('says a group chat or another agent’s chat is not', async () => {
    chatsStore.add('server-1', chat('room-group', 'group', [{ id: 'buddy', name: 'helper' }]));
    chatsStore.add('server-1', chat('room-other', 'direct', [{ id: 'other', name: 'reviewer' }]));

    expect(await sendIn('server-1', 'room-group')).toMatchObject({ toBuddy: 'no' });
    expect(await sendIn('server-1', 'room-other')).toMatchObject({ toBuddy: 'no' });
  });

  it('reads a chat the list does not hold from the server, on any server', async () => {
    calls.get('chats.list')?.mockReset();
    method('chats.list').mockImplementation(async (serverId: string) =>
      serverId === 'server-2'
        ? [chat('room-elsewhere', 'direct', [{ id: 'buddy-2', name: 'switch-buddy-max' }])]
        : []
    );
    method('chats.listArchived').mockResolvedValue([]);

    // Another server: its own list says it is a direct chat with someone's buddy.
    expect(await sendIn('server-2', 'room-elsewhere')).toMatchObject({
      serverId: 'server-2',
      toBuddy: 'yes',
    });
    expect(method('chats.list')).toHaveBeenCalledWith('server-2');
  });

  it('says unknown, not no, when the chat cannot be read', async () => {
    method('chats.list').mockRejectedValue(new Error('offline'));
    method('chats.listArchived').mockResolvedValue([]);

    expect(await sendIn('server-1', 'room-unreadable')).toMatchObject({ toBuddy: 'unknown' });
  });
});
