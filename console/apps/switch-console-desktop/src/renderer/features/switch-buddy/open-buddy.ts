import { focusComposerWhenOpened } from '@switch-console/chat-ui/components/chat-composer';
import type { ChatSummary } from '@switch-console/chat-ui/contracts/chats';
import { chatsStore, chatTitler } from '@renderer/features/chats/stores/chats';
import { bridgePlatformLabel } from '@renderer/lib/components/bridge-platform';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import type { RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { RpcError } from '@shared/lib/ipc/rpc-error';
import { firstNameOf } from './buddy-identity';
import { buddyIntroStore } from './buddy-intro-store';
import { buddyPerson } from './buddy-person';
import { buddyChannelOpener, buddyWelcomeMessage } from './buddy-welcome-message';

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
    (chat) =>
      chat.channelType === 'direct' &&
      // A chat continued in a messaging app is not the Welcome chat.
      chat.bridgeType === null &&
      chat.agents.some((member) => member.id === agentId)
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

/**
 * The same for every attempt to continue with the buddy on one
 * connection, so a double click, a second window or a reopened Console all
 * land on the one chat the server made for the first.
 */
export function buddyHandoffRequestId(agentId: string, bridgeId: string): string {
  return `buddy-handoff:${agentId}:${bridgeId}`;
}

/**
 * A hand-off started again, deliberately, after the person linked a different
 * account than the first one was made for: a new room for that account, never
 * the old one. Fixed by the account too, so a double click or a restart still
 * lands on the one room made for it.
 */
export function buddyRestartedHandoffRequestId(
  agentId: string,
  bridgeId: string,
  externalAccountId: string
): string {
  return `${buddyHandoffRequestId(agentId, bridgeId)}:${externalAccountId}`;
}

/** The handoffs under way, by request id: one at a time each. */
const handingOff = new Map<string, Promise<ChatSummary>>();

type HandoffBridge = Pick<RemoteBridge, 'id' | 'type'>;

function buddyHandoff(serverId: string, agentId: string, bridge: HandoffBridge, requestId: string) {
  return {
    serverId,
    agentIds: [agentId],
    name: null,
    bridgeId: bridge.id,
    requestId,
    greeting: buddyChannelOpener(
      firstNameOf(buddyPerson(serverId).name),
      bridgePlatformLabel(bridge.type)
    ),
  };
}

/** Makes the person's private Slack or Discord channel with their buddy, the buddy opening it. */
export function continueBuddyInChannel(
  serverId: string,
  agent: { agentId: string },
  bridge: HandoffBridge,
  requestId: string
): Promise<ChatSummary> {
  const params = buddyHandoff(serverId, agent.agentId, bridge, requestId);
  const running = handingOff.get(params.requestId);
  if (running) return running;
  const made = rpc.chats
    .create(params)
    .then((chat) => {
      chatsStore.add(serverId, chat);
      return chat;
    })
    .finally(() => handingOff.delete(params.requestId));
  handingOff.set(params.requestId, made);
  return made;
}

/**
 * The buddy's channel on this connection when a hand-off was started
 * there, finishing it if it was cut short; null when none was. Never makes one.
 *
 * When the first hand-off was made for an account no longer linked, the one
 * started again for the account linked now (`accountIds`, the person's
 * accounts on the bridge) is the answer, if there is one; else the server's
 * refusal stands, for the person to start again.
 */
export async function resumeBuddyInChannel(
  serverId: string,
  agentId: string,
  bridge: HandoffBridge,
  accountIds: string[]
): Promise<ChatSummary | null> {
  try {
    return await resumeHandoff(
      serverId,
      agentId,
      bridge,
      buddyHandoffRequestId(agentId, bridge.id)
    );
  } catch (cause) {
    if (!isChatApiError(cause, 'LINKED_ACCOUNT_CHANGED') || accountIds.length !== 1) throw cause;
    const restarted = await resumeHandoff(
      serverId,
      agentId,
      bridge,
      buddyRestartedHandoffRequestId(agentId, bridge.id, accountIds[0])
    );
    if (restarted === null) throw cause;
    return restarted;
  }
}

async function resumeHandoff(
  serverId: string,
  agentId: string,
  bridge: HandoffBridge,
  requestId: string
): Promise<ChatSummary | null> {
  try {
    const chat = await rpc.chats.create({
      ...buddyHandoff(serverId, agentId, bridge, requestId),
      resumeOnly: true,
    });
    chatsStore.add(serverId, chat);
    return chat;
  } catch (cause) {
    if (isChatApiError(cause, 'NO_SUCH_OPERATION')) return null;
    throw cause;
  }
}

function isChatApiError(cause: unknown, apiCode: string): boolean {
  return (
    cause instanceof RpcError &&
    cause.code === 'ChatApiError' &&
    cause.stringField('apiCode') === apiCode
  );
}
