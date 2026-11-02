import { beforeEach, describe, expect, it, vi } from 'vitest';

const listChats = vi.hoisted(() => vi.fn());
const createChat = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
const focusComposerWhenOpened = vi.hoisted(() => vi.fn());
const addChat = vi.hoisted(() => vi.fn());
const titled = vi.hoisted(() => vi.fn());
const skipped = vi.hoisted(() => vi.fn());

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { chats: { list: listChats, create: createChat } },
}));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate } } }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast }));
vi.mock('@renderer/features/chats/components/chat-composer', () => ({
  focusComposerWhenOpened,
}));
vi.mock('@renderer/features/chats/stores/chats', () => ({
  chatsStore: { add: addChat },
  chatTitler: { created: titled },
}));
vi.mock('@renderer/features/switch-servers/switch-servers-store', () => ({
  switchServersStore: { statusFor: () => ({ user: { name: 'Max Tam' } }) },
}));
vi.mock('./buddy-intro-store', () => ({ buddyIntroStore: { skipped } }));
vi.mock('./buddy-welcome-message', () => ({
  buddyWelcomeMessage: ({ firstName, agentName }: { firstName: string; agentName: string }) =>
    `welcome ${firstName} from ${agentName}`,
}));

const { BUDDY_CHAT_NAME, openBuddyAfterOnboarding, openBuddyChat } = await import('./open-buddy');

const buddy = { agentId: 'a-1', name: 'switch-buddy-max' };

function chat(roomId: string, name: string, agentId = 'a-1', channelType = 'direct') {
  return { roomId, name, channelType, agents: [{ id: agentId }] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('openBuddyChat', () => {
  it("opens the buddy's Welcome chat when it has one", async () => {
    listChats.mockResolvedValue([chat('r-other', 'Later'), chat('r-welcome', BUDDY_CHAT_NAME)]);

    await openBuddyChat('srv-1', buddy);

    expect(createChat).not.toHaveBeenCalled();
    expect(focusComposerWhenOpened).toHaveBeenCalledWith('r-welcome');
    expect(navigate).toHaveBeenCalledWith('managedAgent', {
      serverId: 'srv-1',
      agentId: 'a-1',
      name: 'switch-buddy-max',
      roomId: 'r-welcome',
    });
  });

  it('else its newest direct chat, never a room or another agent’s chat', async () => {
    listChats.mockResolvedValue([
      chat('r-room', BUDDY_CHAT_NAME, 'a-1', 'channel_public'),
      chat('r-someone', BUDDY_CHAT_NAME, 'a-2'),
      chat('r-newest', 'Ideas'),
      chat('r-older', 'Notes'),
    ]);

    await openBuddyChat('srv-1', buddy);

    expect(createChat).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(
      'managedAgent',
      expect.objectContaining({ roomId: 'r-newest' })
    );
  });

  it('makes a Welcome chat, with its welcome as the greeting, when the buddy has none', async () => {
    listChats.mockResolvedValue([]);
    const made = chat('r-new', BUDDY_CHAT_NAME);
    createChat.mockResolvedValue(made);

    await openBuddyChat('srv-1', buddy);

    expect(createChat).toHaveBeenCalledWith({
      serverId: 'srv-1',
      agentIds: ['a-1'],
      name: BUDDY_CHAT_NAME,
      requestId: expect.any(String),
      greeting: 'welcome Max from switch-buddy-max',
    });
    expect(addChat).toHaveBeenCalledWith('srv-1', made);
    // Named here, so its first message does not rename it.
    expect(titled).toHaveBeenCalledWith(made, true);
    expect(navigate).toHaveBeenCalledWith(
      'managedAgent',
      expect.objectContaining({ roomId: 'r-new' })
    );
  });

  it('makes one Welcome chat when the chat is opened twice at once', async () => {
    // The setup dialog's success and the buddy page noticing the new buddy
    // both open its chat in the same moment.
    listChats.mockResolvedValue([]);
    createChat.mockResolvedValue(chat('r-new', BUDDY_CHAT_NAME));

    await Promise.all([openBuddyChat('srv-1', buddy), openBuddyChat('srv-1', buddy)]);

    expect(createChat).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(2);
    for (const call of navigate.mock.calls) expect(call[1]).toMatchObject({ roomId: 'r-new' });
  });

  it('looks again for a later open, once the first has finished', async () => {
    listChats.mockResolvedValue([]);
    createChat.mockResolvedValue(chat('r-new', BUDDY_CHAT_NAME));
    await openBuddyChat('srv-1', buddy);

    listChats.mockResolvedValue([chat('r-new', BUDDY_CHAT_NAME)]);
    await openBuddyChat('srv-1', buddy);

    expect(listChats).toHaveBeenCalledTimes(2);
    expect(createChat).toHaveBeenCalledTimes(1);
  });

  it("still opens the buddy's page, and says why, when its chat cannot be had", async () => {
    listChats.mockRejectedValue(new Error('Switch is down.'));

    await openBuddyChat('srv-1', buddy);

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Could not open the chat with switch-buddy' })
    );
    expect(navigate).toHaveBeenCalledWith('managedAgent', {
      serverId: 'srv-1',
      agentId: 'a-1',
      name: 'switch-buddy-max',
    });
  });
});

describe('openBuddyAfterOnboarding', () => {
  it("ends the first run in the buddy's chat once it exists", async () => {
    listChats.mockResolvedValue([chat('r-welcome', BUDDY_CHAT_NAME)]);

    await openBuddyAfterOnboarding('srv-1', buddy);

    expect(navigate).toHaveBeenCalledWith(
      'managedAgent',
      expect.objectContaining({ roomId: 'r-welcome' })
    );
    expect(skipped).not.toHaveBeenCalled();
  });

  it('else on its page, keeping its pop-up away for this launch', async () => {
    await openBuddyAfterOnboarding('srv-1', null);

    expect(navigate).toHaveBeenCalledWith('switchBuddy', { serverId: 'srv-1' });
    expect(skipped).toHaveBeenCalledTimes(1);
    expect(listChats).not.toHaveBeenCalled();
  });
});
