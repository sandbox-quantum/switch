/**
 * An unsent draft, with the mentions picked in it, survives a reload or a
 * restart (both remount the composer from what was kept), is kept apart per
 * account, workspace and room, and goes only once the server has taken it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scope = vi.hoisted(() => ({ userId: 'user-a' as string | null, workspaceId: 'ws-1' }));
vi.mock('@renderer/lib/hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ group_chats: true }),
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { statusFor: () => ({ user: { id: scope.userId } }) },
}));
vi.mock('@renderer/features/workspaces/workspaces-store', () => ({
  workspacesStore: { idOnServerInScope: () => scope.workspaceId },
}));

import { ChatComposer } from '@renderer/features/chats/components/chat-composer';
import {
  chatDraftKey,
  moveChatDraft,
  readChatDraft,
} from '@renderer/features/chats/stores/chat-drafts';
import {
  ChatTimeline,
  ChatTimelines,
  type TimelineApi,
} from '@renderer/features/chats/stores/chat-timeline-store';

const agent = {
  id: 'a2',
  name: 'agent-two',
  displayName: null,
  iconUrl: null,
  provider: null,
  alias: null,
  ownerName: null,
  ownedByViewer: false,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
}

afterEach(unmount);
beforeEach(() => {
  localStorage.clear();
  scope.userId = 'user-a';
  scope.workspaceId = 'ws-1';
});

function api(send: TimelineApi['send']): TimelineApi {
  let n = 0;
  return { newId: () => `id-${++n}`, send } as unknown as TimelineApi;
}

/** Renders the composer for `timeline`; a second call re-renders the same mounted composer. */
async function mount(timeline: ChatTimeline): Promise<HTMLTextAreaElement> {
  if (!root) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () =>
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatComposer
          serverId="srv"
          timeline={timeline}
          agents={[agent]}
          people={[]}
          groupName="Ship review"
          activity={null}
          replyTo={null}
          onClearReply={() => {}}
          disabled={null}
        />
      </QueryClientProvider>
    )
  );
  return container!.querySelector('textarea')!;
}

async function type(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea,
      value
    );
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressEnter(textarea: HTMLTextAreaElement): Promise<void> {
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
  });
}

const key = (userId: string, workspaceId: string, roomId: string) =>
  chatDraftKey({ serverId: 'srv', userId, workspaceId, roomId });

const keptMention = { kind: 'agent' as const, id: 'a2', start: 0, end: 10 };

describe('chat drafts', () => {
  it('come back after a reload or restart with the mentions picked in them', async () => {
    // What an earlier session kept: a picked mention of agent-two.
    localStorage.setItem(
      key('user-a', 'ws-1', 'room-1'),
      JSON.stringify({ text: '@agent-two please review', mentions: [keptMention] })
    );
    const timeline = new ChatTimeline('room-1', api(vi.fn()));
    let textarea = await mount(timeline);
    expect(textarea.value).toBe('@agent-two please review');
    expect(container!.querySelector('mark')?.textContent).toBe('@agent-two');

    await type(textarea, '@agent-two please review today');
    await unmount();
    textarea = await mount(new ChatTimeline('room-1', api(vi.fn())));

    expect(textarea.value).toBe('@agent-two please review today');
    expect(readChatDraft(key('user-a', 'ws-1', 'room-1'))?.mentions).toEqual([keptMention]);
  });

  it('stay with their account, workspace and room', async () => {
    let textarea = await mount(new ChatTimeline('room-1', api(vi.fn())));
    await type(textarea, 'only for user-a in ws-1');
    await unmount();

    for (const [userId, workspaceId, roomId] of [
      ['user-b', 'ws-1', 'room-1'],
      ['user-a', 'ws-2', 'room-1'],
      ['user-a', 'ws-1', 'room-2'],
    ]) {
      scope.userId = userId;
      scope.workspaceId = workspaceId;
      textarea = await mount(new ChatTimeline(roomId, api(vi.fn())));
      expect(textarea.value).toBe('');
      await unmount();
    }
    scope.userId = 'user-a';
    scope.workspaceId = 'ws-1';
    textarea = await mount(new ChatTimeline('room-1', api(vi.fn())));
    expect(textarea.value).toBe('only for user-a in ws-1');
  });

  it('go once the server has taken the message', async () => {
    const textarea = await mount(new ChatTimeline('room-1', api(vi.fn(async () => []))));
    await type(textarea, 'ship it');
    await pressEnter(textarea);
    await act(async () => {});

    expect(textarea.value).toBe('');
    expect(localStorage.getItem(key('user-a', 'ws-1', 'room-1'))).toBeNull();
  });

  it('stay kept when the send fails, so a reload brings the text back', async () => {
    const failing = api(
      vi.fn(async () => {
        throw new Error('network down');
      })
    );
    let textarea = await mount(new ChatTimeline('room-1', failing));
    await type(textarea, 'do not lose me');
    await pressEnter(textarea);
    await act(async () => {});
    expect(textarea.value).toBe('');

    await unmount();
    textarea = await mount(new ChatTimeline('room-1', api(vi.fn())));
    expect(textarea.value).toBe('do not lose me');
  });
  it('move with an unsaved chat to its room, a send in flight showing as sent rather than as text again', async () => {
    let finish: () => void = () => {};
    const send = vi.fn(() => new Promise<[]>((resolve) => (finish = () => resolve([]))));
    const timeline = new ChatTimeline('unsaved-chat:1', api(send));
    let textarea = await mount(timeline);
    await type(textarea, 'first message');
    await pressEnter(textarea);
    expect(textarea.value).toBe('');

    // Its room is made while the send is in flight: the chat reopens under the room's id.
    moveChatDraft(key('user-a', 'ws-1', 'unsaved-chat:1'), key('user-a', 'ws-1', 'r1'));
    timeline.roomId = 'r1';
    await unmount();
    textarea = await mount(timeline);
    expect(textarea.value).toBe('');
    expect(readChatDraft(key('user-a', 'ws-1', 'r1'))?.pendingRequestId).toBe(
      timeline.pending[0]?.requestId
    );
    expect(readChatDraft(key('user-a', 'ws-1', 'unsaved-chat:1'))).toBeNull();

    await act(async () => finish());
    expect(readChatDraft(key('user-a', 'ws-1', 'r1'))).toBeNull();
  });

  describe('of a New chat whose room was made but whose first send failed, across a reload', () => {
    /** Sends the first message of an unsaved chat whose room is made as `r1` and whose send then fails. */
    async function failFirstSend(): Promise<string> {
      const timelines = new ChatTimelines(() =>
        api(
          vi.fn(async () => {
            throw new Error('network down');
          })
        )
      );
      const timeline = timelines.unsaved('srv', 'unsaved-chat:1', async () => {
        moveChatDraft(key('user-a', 'ws-1', 'unsaved-chat:1'), key('user-a', 'ws-1', 'r1'));
        timelines.rekey('srv', 'unsaved-chat:1', 'r1');
        return 'r1';
      });
      const textarea = await mount(timeline);
      await type(textarea, 'first message');
      await pressEnter(textarea);
      await vi.waitFor(() => expect(timeline.pending[0]?.state).toBe('failed'));
      expect(timeline.roomId).toBe('r1');
      await unmount();
      return timeline.pending[0]!.requestId;
    }

    it('reopens as the room, and sends the message again once, under the same request id', async () => {
      const requestId = await failFirstSend();
      expect(readChatDraft(key('user-a', 'ws-1', 'unsaved-chat:1'))).toBeNull();

      const send = vi.fn(async () => []);
      const textarea = await mount(new ChatTimeline('r1', api(send)));
      expect(textarea.value).toBe('first message');
      await pressEnter(textarea);
      await act(async () => {});
      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith('r1', expect.objectContaining({ requestId }));
    });

    it('sends it under a new request id once edited', async () => {
      const requestId = await failFirstSend();
      const send = vi.fn(async () => []);
      // A fresh window's ids: they must not collide with the failed send's.
      const textarea = await mount(
        new ChatTimeline('r1', { ...api(send), newId: () => crypto.randomUUID() })
      );
      await type(textarea, 'first message, edited');
      await pressEnter(textarea);
      await act(async () => {});
      expect(send).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalledWith('r1', expect.objectContaining({ requestId }));
    });
  });

  it('shows the other room’s draft, or none, in the same composer, and never carries one over', async () => {
    localStorage.setItem(
      key('user-a', 'ws-1', 'room-a'),
      JSON.stringify({ text: '@agent-two only for A', mentions: [keptMention] })
    );
    let textarea = await mount(new ChatTimeline('room-a', api(vi.fn())));
    expect(textarea.value).toBe('@agent-two only for A');

    textarea = await mount(new ChatTimeline('room-b', api(vi.fn())));
    expect(textarea.value).toBe('');
    expect(container!.querySelector('mark')).toBeNull();
    expect(localStorage.getItem(key('user-a', 'ws-1', 'room-b'))).toBeNull();

    // Another account in the same room: its own draft, or none.
    textarea = await mount(new ChatTimeline('room-a', api(vi.fn())));
    expect(textarea.value).toBe('@agent-two only for A');
    scope.userId = 'user-b';
    textarea = await mount(new ChatTimeline('room-a', api(vi.fn())));
    expect(textarea.value).toBe('');
    expect(localStorage.getItem(key('user-b', 'ws-1', 'room-a'))).toBeNull();
    expect(readChatDraft(key('user-a', 'ws-1', 'room-a'))?.text).toBe('@agent-two only for A');
  });

  it('keeps what was typed before the account was known, for that account', async () => {
    scope.userId = null;
    let textarea = await mount(new ChatTimeline('room-1', api(vi.fn())));
    await type(textarea, 'typed while starting');
    scope.userId = 'user-a';
    textarea = await mount(new ChatTimeline('room-1', api(vi.fn())));
    expect(textarea.value).toBe('typed while starting');
    expect(readChatDraft(key('user-a', 'ws-1', 'room-1'))?.text).toBe('typed while starting');
  });
  it('keeps a send the window lost before the answer under its request id', async () => {
    const textarea = await mount(
      new ChatTimeline('room-1', api(vi.fn(() => new Promise<never>(() => {}))))
    );
    await type(textarea, 'in flight');
    await pressEnter(textarea);
    expect(textarea.value).toBe('');
    expect(readChatDraft(key('user-a', 'ws-1', 'room-1'))).toEqual({
      text: 'in flight',
      mentions: [],
      pendingRequestId: 'id-1',
      pendingThreadRootId: null,
    });
  });

  it('drops the draft after a reload when that send did land', async () => {
    localStorage.setItem(
      key('user-a', 'ws-1', 'room-1'),
      JSON.stringify({ text: 'in flight', mentions: [], pendingRequestId: 'req-1' })
    );
    const timeline = new ChatTimeline('room-1', api(vi.fn()));
    timeline.apply({
      messageId: 'm1',
      seq: 1,
      roomId: 'room-1',
      sentAt: '2026-01-01T00:00:00Z',
      sender: { clientId: 'c', name: 'Ada', kind: 'human', agentId: null, userId: 'user-a' },
      source: 'console',
      body: 'in flight',
      format: null,
      threadRootId: null,
      attachments: [],
      clientTxn: 'req-1:0',
      namedAgentIds: [],
      namedUserIds: [],
      mentions: [],
      threadReplyCount: 0,
      threadLastReplySeq: null,
    } as never);
    const textarea = await mount(timeline);
    expect(textarea.value).toBe('');
    expect(localStorage.getItem(key('user-a', 'ws-1', 'room-1'))).toBeNull();
  });

  it('restores it when that send did not land, and sends it again under the same request id', async () => {
    localStorage.setItem(
      key('user-a', 'ws-1', 'room-1'),
      JSON.stringify({ text: 'in flight', mentions: [], pendingRequestId: 'req-1' })
    );
    const send = vi.fn(async () => []);
    const textarea = await mount(new ChatTimeline('room-1', api(send)));
    expect(textarea.value).toBe('in flight');
    await pressEnter(textarea);
    await act(async () => {});
    expect(send).toHaveBeenCalledWith('room-1', expect.objectContaining({ requestId: 'req-1' }));
  });
  it('sends an edited restored draft under a new request id', async () => {
    localStorage.setItem(
      key('user-a', 'ws-1', 'room-1'),
      JSON.stringify({ text: 'in flight', mentions: [], pendingRequestId: 'req-1' })
    );
    const send = vi.fn(async () => []);
    const textarea = await mount(new ChatTimeline('room-1', api(send)));
    await type(textarea, 'in flight, edited');
    await pressEnter(textarea);
    await act(async () => {});
    expect(send).toHaveBeenCalledWith('room-1', expect.objectContaining({ requestId: 'id-1' }));
  });
  it('sends the same text twice as two messages, under two request ids', async () => {
    const send = vi.fn(async (_room: string, _input: { requestId: string }) => []);
    const textarea = await mount(new ChatTimeline('room-1', api(send as never)));
    for (let i = 0; i < 2; i++) {
      await type(textarea, 'ok');
      await pressEnter(textarea);
      await act(async () => {});
    }
    expect(send.mock.calls.map(([, input]) => (input as { requestId: string }).requestId)).toEqual([
      'id-1',
      'id-2',
    ]);
  });

  it('leaves the same text alone when it is typed again after a send landed', async () => {
    const send = vi.fn(async (_room: string, input: { requestId: string }) => [
      {
        messageId: 'm1',
        seq: 1,
        roomId: 'room-1',
        sentAt: '2026-01-01T00:00:00Z',
        sender: { clientId: 'c', name: 'Ada', kind: 'human', agentId: null, userId: 'user-a' },
        source: 'console',
        body: 'ok',
        format: null,
        threadRootId: null,
        attachments: [],
        clientTxn: `${input.requestId}:0`,
        namedAgentIds: [],
        namedUserIds: [],
        mentions: [],
        threadReplyCount: 0,
        threadLastReplySeq: null,
      },
    ]);
    const textarea = await mount(new ChatTimeline('room-1', api(send as never)));
    await type(textarea, 'ok');
    await pressEnter(textarea);
    await act(async () => {});
    await type(textarea, 'ok');
    await act(async () => {});
    expect(textarea.value).toBe('ok');
  });

  it('sends a restored draft from another thread under a new request id', async () => {
    localStorage.setItem(
      key('user-a', 'ws-1', 'room-1'),
      JSON.stringify({
        text: 'in flight',
        mentions: [],
        pendingRequestId: 'req-1',
        pendingThreadRootId: 'root-1',
      })
    );
    const send = vi.fn(async () => []);
    const textarea = await mount(new ChatTimeline('room-1', api(send)));
    expect(textarea.value).toBe('in flight');
    await pressEnter(textarea);
    await act(async () => {});
    expect(send).toHaveBeenCalledWith('room-1', expect.objectContaining({ requestId: 'id-1' }));
  });
});
