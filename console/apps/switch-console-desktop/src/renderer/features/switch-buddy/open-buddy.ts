import { focusComposerWhenOpened } from '@renderer/features/chats/components/chat-composer';
import { chatsStore, chatTitler } from '@renderer/features/chats/stores/chats';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import type { ChatSummary } from '@shared/core/chats/chats';
import { firstNameOf } from './buddy-identity';
import { buddyIntroStore } from './buddy-intro-store';
import { buddyPerson } from './buddy-person';
import { buddyWelcomeMessage } from './buddy-welcome-message';

/** What the buddy's first chat is called, as on the board; it keeps it. */
export const BUDDY_CHAT_NAME = 'Welcome';

/** The buddy chats being found or made, by server and agent: one at a time each. */
const finding = new Map<string, Promise<ChatSummary>>();

/**
 * The buddy's chat to open: the one named Welcome, else its newest direct
 * chat; a new Welcome chat only when it has none. Opening the buddy again —
 * replaying onboarding, a second Start — lands in the same chat rather than
 * adding one each time.
 *
 * Two opens at once share one look, so they cannot each find no chat and
 * each make one: the setup dialog's success and the buddy's page noticing it
 * now exists both open it in the same moment.
 */
function buddyChat(
  serverId: string,
  agent: { agentId: string; name: string }
): Promise<ChatSummary> {
  const key = `${serverId}\u0000${agent.agentId}`;
  const running = finding.get(key);
  if (running) return running;
  const found = findOrMakeBuddyChat(serverId, agent).finally(() => finding.delete(key));
  finding.set(key, found);
  return found;
}

async function findOrMakeBuddyChat(
  serverId: string,
  agent: { agentId: string; name: string }
): Promise<ChatSummary> {
  const agentId = agent.agentId;
  const direct = (await rpc.chats.list(serverId)).filter(
    (chat) => chat.channelType === 'direct' && chat.agents.some((member) => member.id === agentId)
  );
  const existing = direct.find((chat) => chat.name === BUDDY_CHAT_NAME) ?? direct[0];
  if (existing) return existing;
  const chat = await rpc.chats.create({
    serverId,
    agentIds: [agentId],
    name: BUDDY_CHAT_NAME,
    requestId: crypto.randomUUID(),
    // Said by the buddy as it joins the chat, in place of its usual line.
    greeting: buddyWelcomeMessage({
      firstName: firstNameOf(buddyPerson(serverId).name),
      agentName: agent.name,
    }),
  });
  chatsStore.add(serverId, chat);
  // Named here, so its first message does not rename it.
  chatTitler.created(chat, true);
  return chat;
}

/**
 * Opens the person's buddy's page, in its chat. When the chat cannot
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
  appState.navigation.navigate('managedAgent', {
    serverId,
    agentId: agent.agentId,
    name: agent.name,
    ...(roomId ? { roomId } : {}),
  });
}

/**
 * Where the first run ends: the buddy's chat once it exists, else its page,
 * which waits for an AI provider. Skipping the buddy there also keeps its
 * pop-up away for the rest of this launch: it was just declined.
 */
export async function openBuddyAfterOnboarding(
  serverId: string,
  agent: { agentId: string; name: string } | null
): Promise<void> {
  if (agent) {
    await openBuddyChat(serverId, agent);
    return;
  }
  buddyIntroStore.skipped();
  appState.navigation.navigate('switchBuddy', { serverId });
}
