import type { ChatSummary } from '@shared/core/chats/chats';
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';

export type BuddySetupStep =
  | { kind: 'loading' }
  | { kind: 'unknown' }
  | { kind: 'connect' }
  | { kind: 'link'; bridge: RemoteBridge }
  | { kind: 'create'; bridge: RemoteBridge }
  | { kind: 'done'; roomId: string };

/**
 * Where the person is in moving their buddy to Slack, from live reads. A read
 * not in yet is `loading`; one that failed is `unknown`, never "not connected".
 */
export function buddySetupStep({
  agentId,
  bridges,
  identities,
  chats,
  failed,
}: {
  agentId: string;
  bridges: RemoteBridge[] | null;
  identities: LinkedIdentity[] | null;
  chats: ChatSummary[] | null;
  failed: boolean;
}): BuddySetupStep {
  const handedOff = chats?.find(
    (chat) =>
      chat.channelType === 'direct' &&
      chat.bridgeType === 'slack' &&
      chat.agents.some((agent) => agent.id === agentId)
  );
  if (handedOff) return { kind: 'done', roomId: handedOff.roomId };
  if (failed) return { kind: 'unknown' };
  if (!bridges || !chats) return { kind: 'loading' };
  const slack = bridges.find((bridge) => bridge.type === 'slack' && bridge.status === 'active');
  if (!slack) return { kind: 'connect' };
  if (!identities) return { kind: 'loading' };
  if (!identities.some((identity) => identity.bridgeId === slack.id))
    return { kind: 'link', bridge: slack };
  return { kind: 'create', bridge: slack };
}
