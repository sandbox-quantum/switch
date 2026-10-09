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
});
export type ChatAgent = z.infer<typeof chatAgentSchema>;

export const chatSummarySchema = z.object({
  roomId: z.string(),
  name: z.string(),
  channelType: z.enum(['channel_public', 'channel_private', 'direct']),
  bridgeType: z.string().nullable(),
  channelName: z.string().nullable(),
  agents: z.array(chatAgentSchema),
  canManage: z.boolean(),
  /** The viewer owns one of the agents, which keeps them in the room: they cannot leave it. */
  ownsAgent: z.boolean().default(false),
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
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  isOwner: z.boolean(),
});
export type ChatMember = z.infer<typeof chatMemberSchema>;

export const chatListSchema = z.object({ chats: z.array(chatSummarySchema) });
export const chatCreatedSchema = z.object({ chat: chatSummarySchema });
export const chatMessagesPageSchema = z.object({
  messages: z.array(chatMessageSchema),
  headSeq: z.number().int(),
  hasMore: z.boolean(),
});
export type ChatMessagesPage = z.infer<typeof chatMessagesPageSchema>;
export const chatSentSchema = z.object({ messages: z.array(chatMessageSchema) });
export const chatUploadSchema = z.object({
  uploadId: z.string(),
  uri: z.string(),
  filename: z.string(),
  mimetype: z.string(),
  size: z.number(),
});
export type ChatUpload = z.infer<typeof chatUploadSchema>;
export const chatMembersSchema = z.object({ members: z.array(chatMemberSchema) });
export const chatRemovedSchema = z.object({ roomId: z.string() });

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
  mentionAgentId: string | null;
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
