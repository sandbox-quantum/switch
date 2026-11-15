import { describe, expect, it, vi } from 'vitest';
import {
  ChatTimelines,
  type TimelineApi,
} from '@renderer/features/chats/stores/chat-timeline-store';
import {
  type ChatScope,
  DirectChatStarter,
  SCOPE_CHANGED,
} from '@renderer/features/chats/stores/direct-chat-starter';
import type { ChatMessage, ChatSummary } from '@shared/core/chats/chats';

const chat = { roomId: 'r1', channelType: 'direct' } as ChatSummary;

/** The starter wired to real timelines, as the app wires it, over fake RPCs. */
function setup(stored = new Map<string, string>()) {
  let id = 0;
  const account = { userId: 'alice' };
  const api = {
    messages: vi.fn(async () => ({ messages: [], headSeq: 0, hasMore: false })),
    threadMessages: vi.fn(),
    upload: vi.fn(),
    send: vi.fn(
      async (roomId: string, input: { requestId: string; body: string }) =>
        [
          {
            roomId,
            seq: 1,
            messageId: 'm1',
            body: input.body,
            clientTxn: `${input.requestId}:0`,
          },
        ] as unknown as ChatMessage[]
    ),
    newId: () => `id-${++id}`,
  } satisfies Partial<TimelineApi>;
  const timelines = new ChatTimelines(() => api as unknown as TimelineApi);
  const create = vi.fn(async (_input: { requestId: string }): Promise<ChatSummary> => chat);
  const created = vi.fn((unsaved: { serverId: string; roomId: string }, made: ChatSummary) =>
    timelines.rekey(unsaved.serverId, unsaved.roomId, made.roomId)
  );
  const starter = new DirectChatStarter({
    create,
    opened: (unsaved: { serverId: string; roomId: string }, make: () => Promise<string>) => {
      if (!timelines.peek(unsaved.serverId, unsaved.roomId))
        timelines.unsaved(unsaved.serverId, unsaved.roomId, make);
    },
    created,
    scope: (serverId: string) => ({ serverId, userId: account.userId, workspaceId: 'w1' }),
    kept: (scope: ChatScope, agentId: string) =>
      stored.get(`${scope.userId}:${scope.serverId}:${agentId}`) ?? null,
    keep: (scope: ChatScope, agentId: string, requestId: string | null) => {
      const key = `${scope.userId}:${scope.serverId}:${agentId}`;
      if (requestId) stored.set(key, requestId);
      else stored.delete(key);
    },
    newId: () => `req-${++id}`,
  });
  return { api, timelines, create, created, starter, stored, account };
}

const message = (body: string) => ({
  body,
  threadRootId: null,
  mentionAgentIds: [],
  mentionUserIds: [],
  mentionSpans: [],
  files: [],
  requestId: null,
});

describe('DirectChatStarter', () => {
  it('opens a chat at once, asking the server for nothing until the first send', async () => {
    const { api, timelines, create, starter } = setup();
    const roomId = starter.start('s1', 'a1');
    const timeline = timelines.get('s1', roomId);
    expect(timeline.loaded).toBe(true);
    await timeline.load();
    expect(create).not.toHaveBeenCalled();
    expect(api.messages).not.toHaveBeenCalled();
    expect(timeline.messages).toEqual([]);
  });

  it('opens the same unsaved chat on every New chat before its first send, never another', () => {
    const { create, starter } = setup();
    const first = starter.start('s1', 'a1');
    expect(starter.start('s1', 'a1')).toBe(first);
    expect(starter.start('s1', 'a2')).not.toBe(first);
    expect(create).not.toHaveBeenCalled();
  });

  it('never reuses an existing chat, whatever it holds', () => {
    const { starter } = setup();
    expect(starter.start('s1', 'a1')).not.toBe(chat.roomId);
  });

  it('makes the room on the first send, then sends to it alone, under the same timeline', async () => {
    const { api, timelines, create, created, starter } = setup();
    const roomId = starter.start('s1', 'a1');
    const timeline = timelines.get('s1', roomId);
    timeline.send(message('hello'));
    expect(timeline.pending.map((send) => send.state)).toEqual(['sending']);
    await vi.waitFor(() => expect(timeline.messages).toHaveLength(1));
    expect(create).toHaveBeenCalledWith({
      serverId: 's1',
      agentIds: ['a1'],
      name: null,
      requestId: expect.stringMatching(/^req-/),
      greeting: null,
    });
    expect(created).toHaveBeenCalledOnce();
    expect(api.send).toHaveBeenCalledOnce();
    expect(api.send.mock.calls[0]![0]).toBe('r1');
    expect(timeline.roomId).toBe('r1');
    expect(timelines.get('s1', 'r1')).toBe(timeline);
    expect(timeline.pending).toEqual([]);
    expect(starter.unsavedChat(roomId)).toBeUndefined();
    // The next New chat is a new chat.
    expect(starter.start('s1', 'a1')).not.toBe(roomId);
  });

  it('makes one room for two sends made while it is being made', async () => {
    const { api, timelines, create, starter } = setup();
    const timeline = timelines.get('s1', starter.start('s1', 'a1'));
    timeline.send(message('one'));
    timeline.send(message('two'));
    await vi.waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenCalledOnce();
    expect(api.send.mock.calls.map((call) => call[0])).toEqual(['r1', 'r1']);
  });

  it('keeps a message whose room could not be made, with its error, and retries under the same request id', async () => {
    const { api, timelines, create, starter } = setup();
    create.mockRejectedValueOnce(new Error('Switch cannot be reached right now.'));
    const roomId = starter.start('s1', 'a1');
    const timeline = timelines.get('s1', roomId);
    const requestId = timeline.send(message('hello'));
    await vi.waitFor(() => expect(timeline.pending[0]?.state).toBe('failed'));
    expect(timeline.pending[0]).toMatchObject({ body: 'hello', requestId });
    expect(timeline.pending[0]?.error).toContain('Switch cannot be reached');
    expect(api.send).not.toHaveBeenCalled();
    // Still the same unsaved chat: a New chat now opens it again rather than another.
    expect(starter.start('s1', 'a1')).toBe(roomId);

    timeline.retry(requestId);
    await vi.waitFor(() => expect(timeline.messages).toHaveLength(1));
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0].requestId).toBe(create.mock.calls[0]![0].requestId);
    expect(api.send).toHaveBeenCalledWith('r1', expect.objectContaining({ requestId }));
  });

  it('retries a first send that failed after its room was made into that room, under its own request id', async () => {
    const { api, timelines, create, starter } = setup();
    const send = api.send.getMockImplementation()!;
    api.send.mockRejectedValueOnce(new Error('The message was not sent.'));
    const timeline = timelines.get('s1', starter.start('s1', 'a1'));
    const requestId = timeline.send(message('hello'));
    await vi.waitFor(() => expect(timeline.pending[0]?.state).toBe('failed'));
    expect(timeline.pending[0]?.body).toBe('hello');
    expect(timeline.roomId).toBe('r1');

    api.send.mockImplementationOnce(send);
    timeline.retry(requestId);
    await vi.waitFor(() => expect(timeline.messages).toHaveLength(1));
    expect(create).toHaveBeenCalledOnce();
    expect(api.send.mock.calls.map((call) => [call[0], call[1].requestId])).toEqual([
      ['r1', requestId],
      ['r1', requestId],
    ]);
    expect(requestId).not.toBe(create.mock.calls[0]![0].requestId);
  });

  it('comes back after a reload or restart under the same create request id, and is forgotten once its room is made', async () => {
    const before = setup();
    const roomId = before.starter.start('s1', 'a1');
    const requestId = before.stored.get('alice:s1:a1');
    expect(requestId).toMatch(/^req-/);

    // A restart: a new starter over what was kept.
    const after = setup(before.stored);
    expect(after.starter.waiting('s1', 'a1')).toBe(roomId);
    expect(after.starter.start('s1', 'a1')).toBe(roomId);
    after.timelines.get('s1', roomId).send(message('hello'));
    await vi.waitFor(() => expect(after.api.send).toHaveBeenCalledOnce());
    expect(after.create.mock.calls[0]![0].requestId).toBe(requestId);
    expect(after.stored.size).toBe(0);
    expect(after.starter.waiting('s1', 'a1')).toBeNull();
  });

  it('keeps each account its own unsaved chat with the same agent, and its own record', () => {
    const { account, create, starter, stored } = setup();
    const alices = starter.start('s1', 'a1');
    account.userId = 'bob';
    const bobs = starter.start('s1', 'a1');
    expect(bobs).not.toBe(alices);
    expect(starter.waiting('s1', 'a1')).toBe(bobs);
    expect(stored.get('alice:s1:a1')).not.toBe(stored.get('bob:s1:a1'));
    expect(stored.get('bob:s1:a1')).toBeDefined();
    account.userId = 'alice';
    expect(starter.start('s1', 'a1')).toBe(alices);
    expect(create).not.toHaveBeenCalled();
  });

  it('never hands a room made after an account switch to the other account', async () => {
    const { account, api, create, created, starter, timelines } = setup();
    let finish: (chat: ChatSummary) => void = () => {};
    create.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const timeline = timelines.get('s1', starter.start('s1', 'a1'));
    timeline.send(message('for alice'));
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    account.userId = 'bob';
    finish(chat);
    await vi.waitFor(() => expect(timeline.pending[0]?.state).toBe('failed'));
    expect(timeline.pending[0]?.error).toContain(SCOPE_CHANGED);
    expect(created).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();

    // Retrying as Bob asks the server for nothing.
    timeline.retry(timeline.pending[0]!.requestId);
    await vi.waitFor(() => expect(timeline.pending[0]?.state).toBe('failed'));
    expect(create).toHaveBeenCalledOnce();
  });
});
