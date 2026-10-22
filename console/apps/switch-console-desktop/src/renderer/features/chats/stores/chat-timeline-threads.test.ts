import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@shared/core/chats/chats';
import { ChatTimeline, type TimelineApi } from './chat-timeline-store';

const makeMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: 'msg-1',
  seq: 1,
  roomId: 'room-1',
  sentAt: '2024-01-01T00:00:00Z',
  sender: {
    clientId: 'client-1',
    name: 'User',
    kind: 'human',
    agentId: null,
    userId: 'user-1',
  },
  source: 'text',
  body: 'Test message',
  format: null,
  threadRootId: null,
  attachments: [],
  clientTxn: null,
  namedAgentIds: [],
  threadReplyCount: 0,
  threadLastReplySeq: null,
  ...overrides,
});

const makeApi = (): TimelineApi => ({
  messages: vi.fn().mockResolvedValue({ messages: [], headSeq: 0, hasMore: false }),
  threadMessages: vi.fn().mockResolvedValue([]),
  upload: vi.fn().mockResolvedValue({ uploadId: '', uri: '', filename: '', mimetype: '', size: 0 }),
  send: vi.fn().mockResolvedValue([]),
  newId: () => crypto.randomUUID(),
});

describe('ChatTimeline thread reply counts', () => {
  it('returns server baseline + new live replies', () => {
    const timeline = new ChatTimeline('room-1', makeApi());
    const root = makeMessage({
      messageId: 'root-1',
      seq: 10,
      threadReplyCount: 5,
      threadLastReplySeq: 14,
    });
    const newReply = makeMessage({ messageId: 'reply-new', seq: 15, threadRootId: 'root-1' });

    timeline.apply(root);
    timeline.apply(newReply);

    expect(timeline.threadReplyCount('root-1')).toBe(6);
  });

  it('does not count fetched history already in server baseline', () => {
    const timeline = new ChatTimeline('room-1', makeApi());
    const root = makeMessage({
      messageId: 'root-1',
      seq: 10,
      threadReplyCount: 3,
      threadLastReplySeq: 13,
    });
    const oldReply1 = makeMessage({ messageId: 'reply-1', seq: 11, threadRootId: 'root-1' });
    const oldReply2 = makeMessage({ messageId: 'reply-2', seq: 12, threadRootId: 'root-1' });

    timeline.apply(root);
    timeline.apply(oldReply1);
    timeline.apply(oldReply2);

    expect(timeline.threadReplyCount('root-1')).toBe(3);
  });

  it('returns null for unloaded root', () => {
    const timeline = new ChatTimeline('room-1', makeApi());
    const reply = makeMessage({ messageId: 'reply-1', seq: 15, threadRootId: 'unloaded-root' });

    timeline.apply(reply);

    expect(timeline.threadReplyCount('unloaded-root')).toBeNull();
  });

  it('applies live replies once root loads without double counting', () => {
    const timeline = new ChatTimeline('room-1', makeApi());
    const liveReply1 = makeMessage({ messageId: 'reply-1', seq: 15, threadRootId: 'root-1' });
    const liveReply2 = makeMessage({ messageId: 'reply-2', seq: 16, threadRootId: 'root-1' });

    timeline.apply(liveReply1);
    timeline.apply(liveReply2);
    expect(timeline.threadReplyCount('root-1')).toBeNull();

    const root = makeMessage({
      messageId: 'root-1',
      seq: 10,
      threadReplyCount: 3,
      threadLastReplySeq: 13,
    });
    timeline.apply(root);

    expect(timeline.threadReplyCount('root-1')).toBe(5);
  });

  it('deduplicates replayed live events by messageId', () => {
    const timeline = new ChatTimeline('room-1', makeApi());
    const root = makeMessage({
      messageId: 'root-1',
      seq: 10,
      threadReplyCount: 2,
      threadLastReplySeq: 12,
    });
    const reply = makeMessage({ messageId: 'reply-1', seq: 15, threadRootId: 'root-1' });

    timeline.apply(root);
    timeline.apply(reply);
    timeline.apply(reply);

    expect(timeline.threadReplyCount('root-1')).toBe(3);
  });

  it('returns 0 for loaded root with no replies', () => {
    const timeline = new ChatTimeline('room-1', makeApi());
    const root = makeMessage({
      messageId: 'root-1',
      seq: 10,
      threadReplyCount: 0,
      threadLastReplySeq: null,
    });

    timeline.apply(root);

    expect(timeline.threadReplyCount('root-1')).toBe(0);
  });

  it('calls threadMessages API when loading a thread', async () => {
    const api = makeApi();
    const timeline = new ChatTimeline('room-1', api);

    await timeline.loadThread('root-1');

    expect(api.threadMessages).toHaveBeenCalledWith('room-1', 'root-1', null, 50);
  });

  it('calls threadMessages with beforeSeq for pagination', async () => {
    const api = makeApi();
    const timeline = new ChatTimeline('room-1', api);

    await timeline.loadThread('root-1', 100);

    expect(api.threadMessages).toHaveBeenCalledWith('room-1', 'root-1', 100, 50);
  });
});
