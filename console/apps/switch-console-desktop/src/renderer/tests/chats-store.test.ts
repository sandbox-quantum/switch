import { describe, expect, it, vi } from 'vitest';
import type { TimelineApi } from '@renderer/features/chats/stores/chat-timeline-store';
import {
  ChatsStore,
  type ChatsApi,
  type ChatsEvents,
} from '@renderer/features/chats/stores/chats-store';
import type { ChatMessage, ChatSummary } from '@shared/core/chats/chats';

vi.mock('@renderer/features/switch-servers/switch-rooms-store', () => ({
  switchRoomsStore: {
    refreshRoomState: vi.fn(async () => {}),
  },
}));

function summary(roomId: string, seq: number): ChatSummary {
  return {
    roomId,
    name: roomId,
    channelType: 'direct',
    bridgeType: null,
    channelName: null,
    agents: [{ id: 'a1', name: 'ada', displayName: null, iconUrl: null, provider: null }],
    canManage: true,
    ownsAgent: false,
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

function setup(
  list: () => Promise<ChatSummary[]>,
  timeline: Partial<TimelineApi> = {},
  identity: ChatsApi['identity'] = async () => ({ userId: 'u', tenantId: 't' })
) {
  let onMessage: Parameters<ChatsEvents['onMessage']>[0] = () => {};
  let onState: Parameters<ChatsEvents['onState']>[0] = () => {};
  const events: ChatsEvents = {
    onMessage: (cb) => {
      onMessage = cb;
      return () => {};
    },
    onSummary: () => () => {},
    onRemoved: () => () => {},
    onState: (cb) => {
      onState = cb;
      return () => {};
    },
    onReset: () => () => {},
  };
  const api: ChatsApi = {
    connect: async () => ({ state: 'live', detail: null }),
    disconnect: vi.fn(async () => {}),
    list: vi.fn(list),
    identity,
    timeline: () => timeline as TimelineApi,
    archive: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  const store = new ChatsStore(api, events);
  return {
    store,
    api,
    emit: (m: ChatMessage) => onMessage({ serverId: 's1', message: m }),
    live: () => onState({ serverId: 's1', state: 'live', detail: null }),
  };
}

describe('ChatsStore', () => {
  it('stops the feed of the server it no longer follows', async () => {
    const { store, api } = setup(async () => []);
    await store.connect('s1');
    expect(api.disconnect).not.toHaveBeenCalled();
    await store.connect('s2');
    expect(api.disconnect).toHaveBeenCalledWith('s1');
    await store.connect(null);
    expect(api.disconnect).toHaveBeenLastCalledWith('s2');
    expect(api.disconnect).toHaveBeenCalledTimes(2);
  });

  it('stops a feed that came up after the store moved on', async () => {
    const { store, api } = setup(async () => []);
    const pending = store.connect('s1');
    await store.connect(null);
    await pending;
    expect(api.disconnect).toHaveBeenNthCalledWith(1, 's1');
    expect(api.disconnect).toHaveBeenNthCalledWith(2, 's1');
  });

  it('brings a hidden chat back when a message arrives in it', async () => {
    let chats = [summary('r1', 1)];
    const { store, api, emit } = setup(async () => chats);
    await store.connect('s1');
    expect(store.chat('r2')).toBeUndefined();

    chats = [summary('r1', 1), summary('r2', 2)];
    emit(message('r2', 2));
    await vi.waitFor(() => expect(store.chat('r2')?.lastMessage?.seq).toBe(2));
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it.each(['archive', 'delete'] as const)(
    'drops a chat once the server agrees to %s it',
    async (op) => {
      const { store, api } = setup(async () => [summary('r1', 1), summary('r2', 1)]);
      await store.connect('s1');
      await store[op]('s1', 'r2');
      expect(api[op]).toHaveBeenCalledWith('s1', 'r2');
      expect(store.chat('r2')).toBeUndefined();
      expect(store.chat('r1')).toBeDefined();
    }
  );

  it.each(['archive', 'delete'] as const)('keeps a chat the server refuses to %s', async (op) => {
    const { store, api } = setup(async () => [summary('r1', 1)]);
    await store.connect('s1');
    vi.mocked(api[op]).mockRejectedValueOnce(new Error('Not authorized'));
    await expect(store[op]('s1', 'r1')).rejects.toThrow('Not authorized');
    expect(store.chat('r1')).toBeDefined();
  });

  it('does not relist for a room the person lost', async () => {
    const { store, api, emit } = setup(async () => [summary('r1', 1)]);
    await store.connect('s1');
    store.remove('r1', 'access');
    emit(message('r1', 2));
    await Promise.resolve();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(store.chat('r1')).toBeUndefined();
  });

  it('lets a chat be read again when access comes back', async () => {
    const { store } = setup(async () => [summary('r1', 1)]);
    await store.connect('s1');
    const timeline = store.timelines.get('s1', 'r1');
    store.remove('r1', 'access');
    expect(timeline.accessLost).toBe(true);
    expect(store.removed.has('r1')).toBe(true);

    store.upsert(summary('r1', 2));
    expect(timeline.accessLost).toBe(false);
    expect(timeline.loaded).toBe(false);
  });

  it('keeps an unlisted chat usable: off the list, not lost', async () => {
    const messages = vi.fn(async () => ({
      messages: [message('r1', 1)],
      headSeq: 1,
      hasMore: false,
    }));
    const { store } = setup(async () => [summary('r1', 1)], { messages });
    await store.connect('s1');
    const timeline = store.timelines.get('s1', 'r1');
    await timeline.load();

    store.remove('r1', 'unlisted');
    expect(store.chat('r1')).toBeUndefined();
    expect(store.removed.has('r1')).toBe(false);
    expect(timeline.accessLost).toBe(false);
    expect(timeline.messages.map((m) => m.seq)).toEqual([1]);
  });

  it('lists an unlisted chat again and catches its open timeline up', async () => {
    let page = [message('r1', 1)];
    const messages = vi.fn(async () => ({ messages: page, headSeq: page.length, hasMore: false }));
    const { store } = setup(async () => [summary('r1', 1)], { messages });
    await store.connect('s1');
    const timeline = store.timelines.get('s1', 'r1');
    await timeline.load();
    store.remove('r1', 'unlisted');

    page = [message('r1', 1), message('r1', 2)];
    store.upsert(summary('r1', 2));
    expect(store.chat('r1')?.lastMessage?.seq).toBe(2);
    await vi.waitFor(() => expect(timeline.messages.map((m) => m.seq)).toEqual([1, 2]));
    expect(timeline.accessLost).toBe(false);
  });

  it('catches an open timeline up to the feed once it is live', async () => {
    let page = [message('r1', 1)];
    const messages = vi.fn(async () => ({ messages: page, headSeq: page.length, hasMore: false }));
    const { store, live } = setup(async () => [summary('r1', 1)], { messages });
    await store.connect('s1');
    const timeline = store.timelines.get('s1', 'r1');
    await timeline.load();

    // Posted before the feed took its cursor: the feed will never deliver it.
    page = [message('r1', 1), message('r1', 2)];
    live();
    await vi.waitFor(() => expect(timeline.messages.map((m) => m.seq)).toEqual([1, 2]));
  });

  it('loads again when the feed goes live during a first load', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const messages = vi.fn(async () => {
      if (calls++ === 0) {
        await first;
        return { messages: [message('r1', 1)], headSeq: 1, hasMore: false };
      }
      return { messages: [message('r1', 1), message('r1', 2)], headSeq: 2, hasMore: false };
    });
    const { store, live } = setup(async () => [summary('r1', 2)], { messages });
    await store.connect('s1');
    const timeline = store.timelines.get('s1', 'r1');
    const loading = timeline.load();
    live();
    release();
    await loading;
    await vi.waitFor(() => expect(timeline.messages.map((m) => m.seq)).toEqual([1, 2]));
  });

  it('revokes a chat unlisted earlier once access is lost', async () => {
    const { store } = setup(async () => [summary('r1', 1)]);
    await store.connect('s1');
    const timeline = store.timelines.get('s1', 'r1');
    store.remove('r1', 'unlisted');
    store.remove('r1', 'access');
    expect(timeline.accessLost).toBe(true);
    expect(store.removed.has('r1')).toBe(true);
    expect(store.unlisted.has('r1')).toBe(false);
  });

  it('does not relist for unlisted rooms', async () => {
    const { store, api, emit } = setup(async () => [summary('r1', 1)]);
    await store.connect('s1');
    store.remove('r1', 'unlisted');
    emit(message('r1', 2));
    await Promise.resolve();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(store.chat('r1')).toBeUndefined();
  });

  it('loads who the person is, their chats and a failed timeline once a feed down at start comes up', async () => {
    let up = false;
    const down = () => Promise.reject(new Error('Could not reach the server'));
    const { store, live } = setup(
      async () => (up ? [summary('r1', 1)] : down()),
      {
        messages: async () =>
          up ? { messages: [message('r1', 1)], headSeq: 1, hasMore: false } : down(),
      },
      async () => (up ? { userId: 'u', tenantId: 't' } : down())
    );
    await store.connect('s1');
    const timeline = store.timelines.get('s1', 'r1');
    await timeline.load();
    expect(store.userId).toBeNull();
    expect(store.listError).not.toBeNull();
    expect(timeline.loadError).not.toBeNull();

    up = true;
    live();
    await vi.waitFor(() => expect(store.userId).toBe('u'));
    await vi.waitFor(() => expect(timeline.loaded).toBe(true));
    expect(store.chat('r1')?.name).toBe('r1');
    expect(store.listError).toBeNull();
    expect(timeline.loadError).toBeNull();
  });

  it('lists again and clears the error when retried on the same server', async () => {
    let up = false;
    const { store, api } = setup(async () =>
      up ? [summary('r1', 1)] : Promise.reject(new Error('Could not reach the server'))
    );
    await store.connect('s1');
    expect(store.listError).not.toBeNull();

    up = true;
    await store.connect('s1');
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(store.listError).toBeNull();
    expect(store.chat('r1')?.name).toBe('r1');
  });

  it('reads a chat once the person is let into it after a refused first load', async () => {
    const { store } = setup(async () => []);
    await store.connect('s1');
    const timeline = store.timelines.get('s1', 'r1');
    timeline.notMember = true;

    store.upsert(summary('r1', 1));
    expect(timeline.notMember).toBe(false);
    expect(timeline.loaded).toBe(false);
  });
});
