import { describe, expect, it, vi } from 'vitest';
import type { TimelineApi } from '@renderer/features/chats/stores/chat-timeline-store';
import {
  ChatsStore,
  type ChatsApi,
  type ChatsEvents,
} from '@renderer/features/chats/stores/chats-store';
import type { ChatMessage, ChatSummary } from '@shared/core/chats/chats';

function summary(roomId: string, seq: number): ChatSummary {
  return {
    roomId,
    name: roomId,
    channelType: 'direct',
    bridgeType: null,
    channelName: null,
    agents: [{ id: 'a1', name: 'ada', displayName: null, iconUrl: null, provider: null }],
    canManage: true,
    lastMessage: { seq, sentAt: '2026-01-01T00:00:00Z', preview: 'hi', senderName: 'Ada' },
  };
}

function message(roomId: string, seq: number): ChatMessage {
  return {
    messageId: `m${seq}`,
    seq,
    roomId,
    sentAt: '2026-01-01T00:00:00Z',
    sender: { clientId: 'c', name: 'Ada', kind: 'human', agentId: null, userId: 'u' },
    source: 'console',
    body: `body ${seq}`,
    format: null,
    threadRootId: null,
    attachments: [],
    clientTxn: null,
  };
}

function setup(list: () => Promise<ChatSummary[]>) {
  let onMessage: Parameters<ChatsEvents['onMessage']>[0] = () => {};
  const events: ChatsEvents = {
    onMessage: (cb) => {
      onMessage = cb;
      return () => {};
    },
    onSummary: () => () => {},
    onRemoved: () => () => {},
    onState: () => () => {},
    onReset: () => () => {},
  };
  const api: ChatsApi = {
    connect: async () => ({ state: 'live', detail: null }),
    list: vi.fn(list),
    identity: async () => ({ userId: 'u', tenantId: 't' }),
    timeline: () => ({}) as TimelineApi,
  };
  const store = new ChatsStore(api, events);
  return { store, api, emit: (m: ChatMessage) => onMessage({ serverId: 's1', message: m }) };
}

describe('ChatsStore', () => {
  it('brings a hidden chat back when a message arrives in it', async () => {
    let chats = [summary('r1', 1), summary('r2', 1)];
    const { store, api, emit } = setup(async () => chats);
    await store.connect('s1');
    store.hide('r2');
    expect(store.chat('r2')).toBeUndefined();

    chats = [summary('r1', 1), summary('r2', 2)];
    emit(message('r2', 2));
    await vi.waitFor(() => expect(store.chat('r2')?.lastMessage?.seq).toBe(2));
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('does not relist for a room the person lost', async () => {
    const { store, api, emit } = setup(async () => [summary('r1', 1)]);
    await store.connect('s1');
    store.remove('r1');
    emit(message('r1', 2));
    await Promise.resolve();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(store.chat('r1')).toBeUndefined();
  });
});
