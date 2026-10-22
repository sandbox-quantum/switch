import { z } from 'zod';

/**
 * A chat is a Switch room the signed-in person is a member of and that has at
 * least one agent in it. Everything here is the gateway's `/chats` contract,
 * parsed at the main-process boundary so the renderer only ever sees values
 * that matched it.
 */

export const chatAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().nullable(),
  iconUrl: z.string().nullable(),
  provider: z.string().nullable(),
  alias: z.string().nullable(),
  ownerName: z.string().nullable(),
  ownedByViewer: z.boolean(),
});
export type ChatAgent = z.infer<typeof chatAgentSchema>;

export const chatSummarySchema = z.object({
  roomId: z.string(),
  name: z.string(),
  channelType: z.enum(['lobby', 'channel_public', 'channel_private', 'group', 'direct']),
  bridgeType: z.string().nullable(),
  channelName: z.string().nullable(),
  agents: z.array(chatAgentSchema),
  canManage: z.boolean(),
  /** The viewer owns one of the agents, which keeps them in the room: they cannot leave it. */
  ownsAgent: z.boolean().default(false),
  /** The people in the chat, by user id, sorted. */
  memberUserIds: z.array(z.string()),
  memberCount: z.number().int(),
  lastMessage: z
    .object({
      seq: z.number().int(),
      sentAt: z.string(),
      preview: z.string(),
      senderName: z.string(),
    })
    .nullable(),
});
export type ChatSummary = z.infer<typeof chatSummarySchema>;

export const chatSenderSchema = z.object({
  clientId: z.string(),
  name: z.string(),
  kind: z.enum(['human', 'agent', 'system']),
  agentId: z.string().nullable(),
  userId: z.string().nullable(),
});
export type ChatSender = z.infer<typeof chatSenderSchema>;

export const chatAttachmentSchema = z.object({
  uri: z.string(),
  filename: z.string(),
  mimetype: z.string(),
  size: z.number(),
  msgtype: z.string(),
});
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;

export const chatMessageSchema = z.object({
  messageId: z.string(),
  seq: z.number().int(),
  roomId: z.string(),
  sentAt: z.string(),
  sender: chatSenderSchema,
  source: z.string(),
  body: z.string(),
  format: z.string().nullable(),
  threadRootId: z.string().nullable(),
  attachments: z.array(chatAttachmentSchema),
  clientTxn: z.string().nullable(),
  namedAgentIds: z.array(z.string()),
  threadReplyCount: z.number().int(),
  threadLastReplySeq: z.number().int().nullable(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatListSchema = z.object({ chats: z.array(z.unknown()) });
export const chatCreatedSchema = z.object({ chat: chatSummarySchema });
export const chatMessagesPageSchema = z.object({
  messages: z.array(chatMessageSchema),
  headSeq: z.number().int(),
  hasMore: z.boolean(),
});
export type ChatMessagesPage = z.infer<typeof chatMessagesPageSchema>;
export const chatThreadMessagesPageSchema = z.object({
  messages: z.array(chatMessageSchema),
  headSeq: z.number().int(),
  hasMore: z.boolean(),
});
export type ChatThreadMessagesPage = z.infer<typeof chatThreadMessagesPageSchema>;
export const chatSentSchema = z.object({ messages: z.array(chatMessageSchema) });
export const chatAgentAddedSchema = z.object({ chat: chatSummarySchema });
export const chatMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  isOwner: z.boolean(),
});
export type ChatMember = z.infer<typeof chatMemberSchema>;
export const chatMemberListSchema = z.object({ members: z.array(chatMemberSchema) });
/** A person in the workspace, from its roster, who could be added to a chat. */
export const workspaceMemberSchema = z
  .object({
    user_id: z.string(),
    name: z.string(),
    email: z.string().nullish(),
    // Older servers do not report it; they have no way to mark one.
    service_account: z.boolean().optional(),
  })
  .transform(({ user_id, name, email, service_account }) => ({
    userId: user_id,
    name,
    email: email || null,
    serviceAccount: service_account ?? false,
  }));
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;
/** The agents the viewer may add to a new chat, or to one they manage. */
export const agentCandidatesSchema = z.object({ agentIds: z.array(z.string()) });
export const chatUploadSchema = z.object({
  uploadId: z.string(),
  uri: z.string(),
  filename: z.string(),
  mimetype: z.string(),
  size: z.number(),
});
export type ChatUpload = z.infer<typeof chatUploadSchema>;
/**
 * `access`: the person lost the room (membership, workspace role, archive).
 * `unlisted`: still a member, but the room no longer qualifies for the list.
 */
export const chatRemovalReasonSchema = z.enum(['access', 'unlisted']);
export type ChatRemovalReason = z.infer<typeof chatRemovalReasonSchema>;
export const chatRemovedSchema = z.object({
  roomId: z.string(),
  reason: chatRemovalReasonSchema,
});

/** The gateway's coded refusal: `{ detail: { code, message } }`. */
export const chatErrorBodySchema = z.object({
  detail: z.object({ code: z.string(), message: z.string() }),
});

/**
 * The live feed's state. `live` is only reached after the server's `ready`,
 * which it sends once every member room has been caught up from its cursor.
 */
export type ChatStreamState = 'connecting' | 'catching-up' | 'live' | 'offline';

export type ChatSendInput = {
  serverId: string;
  roomId: string;
  requestId: string;
  body: string;
  threadRootId: string | null;
  uploadIds: string[];
  mentionAgentIds?: string[];
};

export type ChatUploadInput = {
  serverId: string;
  roomId: string;
  uploadId: string;
  name: string;
  mimeType: string;
  /** The file's bytes, base64. */
  data: string;
};

/** The display name the room and the platforms show for an agent. */
export function chatAgentLabel(agent: Pick<ChatAgent, 'name' | 'displayName'>): string {
  return agent.displayName ?? agent.name;
}

/** The `clientTxn` a Console send's parts carry: `{requestId}:{index}`. */
export function requestIdOfClientTxn(clientTxn: string | null): string | null {
  if (clientTxn === null) return null;
  const at = clientTxn.lastIndexOf(':');
  return at > 0 ? clientTxn.slice(0, at) : null;
}

/** The notice an agent posts to a room while a session starts to answer it. */
export const SESSION_STARTING_MESSAGE = 'Starting a session to handle this — one moment.';

export function isSessionStartingNotice(message: ChatMessage): boolean {
  return message.sender.kind === 'agent' && message.body.trim() === SESSION_STARTING_MESSAGE;
}

/**
 * The session-starting notices still current: each is its agent's latest
 * message, and that agent shows no turn yet for the message it answers or any
 * later one. `turnAgents` maps a message id to the agents with a turn under it.
 */
export function liveSessionStartingNotices(
  messages: readonly ChatMessage[],
  turnAgents: ReadonlyMap<string, ReadonlySet<string>>
): Set<string> {
  const live = new Set<string>();
  const seen = new Set<string>();
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at];
    if (message.sender.kind !== 'agent' || seen.has(message.sender.clientId)) continue;
    seen.add(message.sender.clientId);
    if (!isSessionStartingNotice(message)) continue;
    let from = at;
    while (from > 0 && messages[from].sender.kind !== 'human') from--;
    const agentId = message.sender.agentId;
    const working = messages
      .slice(from)
      .some((each) => agentId !== null && turnAgents.get(each.messageId)?.has(agentId));
    if (!working) live.add(message.messageId);
  }
  return live;
}

/** What the host posts for a turn that ended without the agent posting, then why it ended. */
export const UNPOSTED_REPLY_MESSAGE = 'I finished without replying.';
export const TURN_FAILED_PHRASE = 'The turn failed';
export const TURN_INTERRUPTED_PHRASE = 'The turn was interrupted';

export type TurnEndNotice = {
  outcome: 'completed' | 'failed' | 'interrupted';
  reason: string | null;
};

/** The host's notice of a turn that ended without a reply, or null for any other message. */
export function turnEndNotice(message: ChatMessage): TurnEndNotice | null {
  const body = message.body.trim();
  if (message.sender.kind !== 'agent' || !body.startsWith(UNPOSTED_REPLY_MESSAGE)) return null;
  const rest = body.slice(UNPOSTED_REPLY_MESSAGE.length).trim();
  if (!rest) return { outcome: 'completed', reason: null };
  for (const [phrase, outcome] of [
    [TURN_FAILED_PHRASE, 'failed'],
    [TURN_INTERRUPTED_PHRASE, 'interrupted'],
  ] as const) {
    if (rest === `${phrase}.`) return { outcome, reason: null };
    // An interrupt is the person's Stop; the provider's raw reason for it says nothing more.
    if (rest.startsWith(`${phrase}: `))
      return {
        outcome,
        reason: outcome === 'interrupted' ? null : rest.slice(phrase.length + 2).trim(),
      };
  }
  return null;
}
