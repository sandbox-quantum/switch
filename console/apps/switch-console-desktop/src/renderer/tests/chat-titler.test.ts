import { describe, expect, it, vi } from 'vitest';
import { ChatTitler } from '@renderer/features/chats/stores/chat-titler';
import type { ChatSummary } from '@shared/core/chats/chats';

function summary(roomId: string, channelType: ChatSummary['channelType'] = 'direct'): ChatSummary {
  return {
    roomId,
    name: 'Chat with ada',
    channelType,
    bridgeType: null,
    channelName: null,
    agents: [{ id: 'a1', name: 'ada', displayName: null, iconUrl: null, provider: null }],
    canManage: true,
    ownsAgent: false,
    lastMessage: null,
  };
}

function setup(title: () => Promise<string>) {
  const chats = new Map<string, ChatSummary>();
  const deps = {
    title: vi.fn(title),
    rename: vi.fn(async () => {}),
    chat: (roomId: string) => chats.get(roomId),
    add: vi.fn((_serverId: string, chat: ChatSummary) => void chats.set(chat.roomId, chat)),
    warn: vi.fn(),
  };
  return { chats, deps, titler: new ChatTitler(deps) };
}

describe('ChatTitler', () => {
  it('names an unnamed direct chat from its first message, once', async () => {
    const { chats, deps, titler } = setup(async () => 'Arm build failure');
    chats.set('r1', summary('r1'));
    titler.created(summary('r1'), false);
    await titler.sent('s1', 'r1', 'why does the arm build fail?');
    await titler.sent('s1', 'r1', 'second message');
    expect(deps.title).toHaveBeenCalledOnce();
    expect(deps.rename).toHaveBeenCalledWith('s1', 'r1', 'Arm build failure');
    expect(chats.get('r1')?.name).toBe('Arm build failure');
  });

  it('leaves a named chat, a channel and a chat not created here alone', async () => {
    const { chats, deps, titler } = setup(async () => 'Title');
    for (const id of ['named', 'channel', 'elsewhere']) chats.set(id, summary(id));
    titler.created(summary('named'), true);
    titler.created(summary('channel', 'channel_private'), false);
    for (const id of ['named', 'channel', 'elsewhere']) await titler.sent('s1', id, 'hello');
    expect(deps.title).not.toHaveBeenCalled();
  });

  it('waits for a message with text', async () => {
    const { chats, deps, titler } = setup(async () => 'Title');
    chats.set('r1', summary('r1'));
    titler.created(summary('r1'), false);
    await titler.sent('s1', 'r1', '  ');
    await titler.sent('s1', 'r1', 'hello');
    expect(deps.title).toHaveBeenCalledWith('hello');
  });

  it('keeps a name the user gave while the title was written', async () => {
    const { chats, deps, titler } = setup(async () => {
      chats.set('r1', { ...summary('r1'), name: 'Mine' });
      return 'Generated';
    });
    chats.set('r1', summary('r1'));
    titler.created(summary('r1'), false);
    await titler.sent('s1', 'r1', 'hello');
    expect(deps.rename).not.toHaveBeenCalled();
    expect(chats.get('r1')?.name).toBe('Mine');
  });

  it('warns and keeps the default name when the title fails', async () => {
    const { chats, deps, titler } = setup(async () => {
      throw new Error('claude not found');
    });
    chats.set('r1', summary('r1'));
    titler.created(summary('r1'), false);
    await titler.sent('s1', 'r1', 'hello');
    expect(deps.warn).toHaveBeenCalledOnce();
    expect(deps.rename).not.toHaveBeenCalled();
    expect(chats.get('r1')?.name).toBe('Chat with ada');
  });
});
