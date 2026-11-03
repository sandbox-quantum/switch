import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import { readThroughSeq } from '@renderer/features/chats/read-progress';
import type { TimelineApi } from '@renderer/features/chats/stores/chat-timeline-store';
import {
  ChatsStore,
  type ChatsApi,
  type ChatsEvents,
  READ_DEBOUNCE_MS,
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
    agents: [
      {
        id: 'a1',
        name: 'ada',
        displayName: null,
        iconUrl: null,
        provider: null,
        alias: null,
        ownerName: null,
        ownedByViewer: false,
      },
    ],
    canManage: true,
    ownsAgent: false,
    memberUserIds: [],
    memberCount: 0,
    unreadCount: 0,
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
    namedAgentIds: [],
    namedUserIds: [],
    mentions: [],
    threadReplyCount: 0,
    threadLastReplySeq: null,
  };
}

function setup(
  list: () => Promise<ChatSummary[]>,
  timeline: Partial<TimelineApi> = {},
  identity: ChatsApi['identity'] = async () => ({ userId: 'u', tenantId: 't' }),
  listArchived: () => Promise<ChatSummary[]> = async () => []
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
    connect: vi.fn(async () => ({ state: 'live' as const, detail: null })),
    disconnect: vi.fn(async () => {}),
    list: vi.fn(list),
    listArchived: vi.fn(listArchived),
    identity,
    timeline: () => timeline as TimelineApi,
    archive: vi.fn(async () => {}),
    unarchive: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    markRead: vi.fn(async () => {}),
    removeMember: vi.fn(async () => {}),
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
  it('opens the feed again, keeping nothing of the last account, when the sign-in changes', async () => {
    const { store, api } = setup(async () => [summary('r1', 1)]);
    const scope = observable({ key: 'ws:t:user-a' as string | null });
    const stop = store.follow(() => ({ serverId: 's1', key: scope.key }));
    await vi.waitFor(() => expect(store.chats.size).toBe(1));
    expect(api.connect).toHaveBeenCalledTimes(1);

    runInAction(() => (scope.key = 'ws:t:null'));
    await vi.waitFor(() => expect(api.connect).toHaveBeenCalledTimes(2));
    expect(api.disconnect).toHaveBeenCalledWith('s1');
    runInAction(() => (scope.key = 'ws:t:user-a'));
    await vi.waitFor(() => expect(api.connect).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(store.streamState).toBe('live'));
    expect(store.chats.size).toBe(1);
    stop();
  });

  it('reads every summary again, so a renamed agent shows its new name', async () => {
    let name = 'ada';
    const { store } = setup(async () => {
      const chat = summary('r1', 1);
      return [{ ...chat, agents: [{ ...chat.agents[0], name }] }];
    });
    await store.connect('s1');
    expect(store.chats.get('r1')?.agents[0].name).toBe('ada');

    name = 'blair';
    await store.refreshSummaries();
    expect(store.chats.get('r1')?.agents[0].name).toBe('blair');
  });

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

  it('drops a chat once the server agrees to delete it', async () => {
    const { store, api } = setup(async () => [summary('r1', 1), summary('r2', 1)]);
    await store.connect('s1');
    await store.delete('s1', 'r2');
    expect(api.delete).toHaveBeenCalledWith('s1', 'r2');
    expect(store.chat('r2')).toBeUndefined();
    expect(store.chat('r1')).toBeDefined();
  });

  it('moves an archived chat off the list into the archive, still openable', async () => {
    const { store, api } = setup(async () => [summary('r1', 1), summary('r2', 1)]);
    await store.connect('s1');
    await store.archive('s1', 'r2');
    expect(api.archive).toHaveBeenCalledWith('s1', 'r2');
    expect(store.chats.has('r2')).toBe(false);
    expect(store.archivedOfAgent('a1').map((chat) => chat.roomId)).toEqual(['r2']);
    expect(store.chat('r2')).toBeDefined();
    expect(store.removed.has('r2')).toBe(false);
  });

  it('lists the archived chats the server holds, and brings one back when it is listed again', async () => {
    const { store } = setup(
      async () => [summary('r1', 1)],
      {},
      undefined,
      async () => [summary('r2', 1)]
    );
    await store.connect('s1');
    expect([...store.archived.keys()]).toEqual(['r2']);

    store.upsert(summary('r2', 2));
    expect(store.archived.size).toBe(0);
    expect(store.chats.has('r2')).toBe(true);
  });

  it('unarchives a chat back onto the list', async () => {
    const { store, api } = setup(
      async () => [],
      {},
      undefined,
      async () => [summary('r2', 1)]
    );
    await store.connect('s1');
    await store.unarchive('s1', 'r2');
    expect(api.unarchive).toHaveBeenCalledWith('s1', 'r2');
    expect(store.chats.has('r2')).toBe(true);
    expect(store.archived.size).toBe(0);
  });

  it('says so when the archive cannot be listed, keeping the chats', async () => {
    const { store } = setup(
      async () => [summary('r1', 1)],
      {},
      undefined,
      async () => {
        throw new Error('boom');
      }
    );
    await store.connect('s1');
    expect(store.chats.has('r1')).toBe(true);
    expect(store.archivedError).not.toBeNull();
  });

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

  it('holds all of an empty room once it is listed again with 130 messages', async () => {
    let head = 0;
    const messages = vi.fn(async (_room: string, before: number | null, limit: number) => {
      const top = Math.min(before ?? head + 1, head + 1);
      const from = Math.max(1, top - limit);
      const seqs = Array.from({ length: Math.max(0, top - from) }, (_, i) => from + i);
      return { messages: seqs.map((seq) => message('r1', seq)), headSeq: head, hasMore: from > 1 };
    });
    const { store } = setup(async () => [summary('r1', 0)], { messages });
    await store.connect('s1');
    const timeline = store.timelines.get('s1', 'r1');
    await timeline.load();
    expect(timeline.messages).toHaveLength(0);
    store.remove('r1', 'unlisted');

    head = 130;
    store.upsert(summary('r1', 130));
    await vi.waitFor(() =>
      expect(timeline.messages.map((m) => m.seq)).toEqual(
        Array.from({ length: 130 }, (_, i) => i + 1)
      )
    );
    expect(timeline.hasMore).toBe(false);
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

/** A viewer's store whose feed the test drives, already connected to `s1`. */
async function viewer() {
  let onSummary: Parameters<ChatsEvents['onSummary']>[0] = () => {};
  let onMessage: Parameters<ChatsEvents['onMessage']>[0] = () => {};
  const markRead = vi.fn(async () => {});
  const removeMember = vi.fn(async (_serverId: string, _roomId: string, _userId: string) => {});
  const events: ChatsEvents = {
    onMessage: (cb) => {
      onMessage = cb;
      return () => {};
    },
    onSummary: (cb) => {
      onSummary = cb;
      return () => {};
    },
    onRemoved: () => () => {},
    onState: () => () => {},
    onReset: () => () => {},
  };
  const group = { ...summary('g', 1), channelType: 'channel_private' as const };
  const store = new ChatsStore(
    {
      connect: async () => ({ state: 'live', detail: null }),
      disconnect: async () => {},
      list: async () => [group],
      listArchived: async () => [],
      identity: async () => ({ userId: 'u', tenantId: 't' }),
      timeline: () => ({}) as TimelineApi,
      archive: async () => {},
      unarchive: async () => {},
      delete: async () => {},
      markRead,
      removeMember,
    },
    events
  );
  await store.connect('s1');
  return {
    store,
    push: (chat: ChatSummary) => onSummary({ serverId: 's1', chat }),
    emit: (m: ChatMessage) => onMessage({ serverId: 's1', message: m }),
    markRead,
    removeMember,
    group,
  };
}

describe('ChatsStore membership', () => {
  it('keeps both of two quick agent removals and a feed update in between', async () => {
    const { store, push, group } = await viewer();
    const a = (id: string) => ({ ...group.agents[0], id });
    push({ ...group, agents: [a('a1'), a('a2'), a('a3')] });
    store.dropAgent('g', 'a1');
    push({ ...group, name: 'renamed', agents: [a('a2'), a('a3')] });
    store.dropAgent('g', 'a2');
    expect(store.chat('g')?.agents.map((agent) => agent.id)).toEqual(['a3']);
    expect(store.chat('g')?.name).toBe('renamed');
  });
});

describe('ChatsStore unread counts', () => {
  const from = (roomId: string, seq: number, userId: string) => ({
    ...message(roomId, seq),
    sender: { ...message(roomId, seq).sender, userId },
  });

  it('counts others’ new messages in rooms not being read, and takes the server’s count', async () => {
    const { store, emit, push, group } = await viewer();
    emit(from('g', 2, 'bob'));
    emit(from('g', 3, 'bob'));
    emit(from('g', 3, 'bob'));
    expect(store.unread('g')).toBe(2);
    emit(from('g', 4, 'u'));
    expect(store.unread('g')).toBe(2);
    store.setViewing('g');
    emit(from('g', 5, 'bob'));
    expect(store.unread('g')).toBe(0);
    store.setViewing(null);
    expect(store.unread('g')).toBe(2);
    push({ ...group, unreadCount: 7 });
    expect(store.unread('g')).toBe(7);
  });

  it('marks read at once here and sends the furthest position once, never backwards', async () => {
    vi.useFakeTimers();
    try {
      const { store, push, group, markRead } = await viewer();
      push({ ...group, unreadCount: 3 });
      store.read('g', 5);
      store.read('g', 9);
      expect(store.unread('g')).toBe(0);
      vi.advanceTimersByTime(READ_DEBOUNCE_MS);
      expect(markRead).toHaveBeenCalledTimes(1);
      expect(markRead).toHaveBeenCalledWith('s1', 'g', 9);
      store.read('g', 4);
      vi.advanceTimersByTime(READ_DEBOUNCE_MS);
      expect(markRead).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ChatsStore leave', () => {
  it('removes the viewer and drops the chat from the list', async () => {
    const { store, removeMember } = await viewer();
    await store.leave('s1', 'g');
    expect(removeMember).toHaveBeenCalledWith('s1', 'g', 'u');
    expect(store.chat('g')).toBeUndefined();
    expect(store.removed.has('g')).toBe(true);
  });

  it('keeps the chat as it was when the server refuses', async () => {
    const { store, removeMember } = await viewer();
    removeMember.mockRejectedValueOnce(new Error('You own an agent in this chat.'));
    await expect(store.leave('s1', 'g')).rejects.toThrow('You own an agent in this chat.');
    expect(store.chat('g')).toBeDefined();
    expect(store.removed.has('g')).toBe(false);
  });
});

describe('ChatsStore read progress', () => {
  const from = (roomId: string, seq: number) => ({
    ...message(roomId, seq),
    sender: { ...message(roomId, seq).sender, userId: 'bob' },
  });

  it('counts arrivals while scrolled up, and reads them once back at the bottom', async () => {
    vi.useFakeTimers();
    try {
      const { store, emit, markRead } = await viewer();
      store.setViewing(null);
      emit(from('g', 2));
      expect(store.unread('g')).toBe(1);
      const seq = readThroughSeq({ shown: true, atBottom: false, lastSeq: 2 });
      expect(seq).toBeNull();
      store.setViewing('g');
      store.read('g', readThroughSeq({ shown: true, atBottom: true, lastSeq: 2 })!);
      expect(store.unread('g')).toBe(0);
      vi.advanceTimersByTime(READ_DEBOUNCE_MS);
      expect(markRead).toHaveBeenCalledWith('s1', 'g', 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tries a failed read again the next time the same messages are shown', async () => {
    vi.useFakeTimers();
    try {
      const { store, markRead } = await viewer();
      markRead.mockRejectedValueOnce(new Error('offline'));
      store.read('g', 5);
      await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS);
      expect(markRead).toHaveBeenCalledTimes(1);
      store.read('g', 5);
      await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS);
      expect(markRead).toHaveBeenCalledTimes(2);
      store.read('g', 5);
      await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS);
      expect(markRead).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
