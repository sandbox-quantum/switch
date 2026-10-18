import { focusComposerWhenOpened } from '@renderer/features/chats/components/chat-composer';
import { chatsStore, chatTitler } from '@renderer/features/chats/stores/chats';
import { agentTabStore } from '@renderer/features/managed-agents/agent-tab-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import type { ChatSummary } from '@shared/core/chats/chats';
import { firstNameOf } from './buddy-identity';
import { buddyWelcomeMessage } from './buddy-welcome-message';

/** What the buddy's first chat is called, as on the board; it keeps it. */
export const BUDDY_CHAT_NAME = 'Welcome';

/**
 * The buddy's chat to open: the one named Welcome, else its newest direct
 * chat; a new Welcome chat only when it has none. Opening the buddy again —
 * replaying onboarding, a second Start — lands in the same chat rather than
 * adding one each time.
 */
async function buddyChat(
  serverId: string,
  agent: { agentId: string; name: string }
): Promise<ChatSummary> {
  const agentId = agent.agentId;
  const direct = (await rpc.chats.list(serverId)).filter(
    (chat) => chat.channelType === 'direct' && chat.agents.some((member) => member.id === agentId)
  );
  const existing = direct.find((chat) => chat.name === BUDDY_CHAT_NAME) ?? direct[0];
  if (existing) return existing;
  const user = switchServersStore.statusFor(serverId)?.user ?? null;
  const chat = await rpc.chats.create({
    serverId,
    agentIds: [agentId],
    name: BUDDY_CHAT_NAME,
    requestId: crypto.randomUUID(),
    // Said by the buddy as it joins the chat, in place of its usual line.
    greeting: buddyWelcomeMessage({ firstName: firstNameOf(user?.name), agentName: agent.name }),
  });
  chatsStore.add(serverId, chat);
  // Named here, so its first message does not rename it.
  chatTitler.created(chat, true);
  return chat;
}

/**
 * Opens the person's buddy on its Chats tab, in its chat. When the chat cannot
 * be had the agent's page still opens, and a toast says why.
 */
export async function openBuddyChat(
  serverId: string,
  agent: { agentId: string; name: string }
): Promise<void> {
  let roomId: string | null = null;
  try {
    roomId = (await buddyChat(serverId, agent)).roomId;
    focusComposerWhenOpened(roomId);
  } catch (cause) {
    toast({
      title: 'Could not open the chat with switch-buddy',
      description: failureText(cause, 'Switch did not answer.'),
      variant: 'destructive',
    });
  }
  agentTabStore.setTab(agent.agentId, 'chats');
  appState.navigation.navigate('managedAgent', {
    serverId,
    agentId: agent.agentId,
    name: agent.name,
    ...(roomId ? { roomId } : {}),
  });
}
