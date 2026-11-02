import type { z } from 'zod';
import { GatewayError, gatewayFetch } from '@main/core/switch-servers/gateway-client';
import { log } from '@main/lib/logger';
import {
  type ChatApproval,
  type ChatApprovalAnswer,
  chatApprovalSchema,
  chatControlAcceptedSchema,
  type ChatControlCommand,
  type RoomActivity,
  roomActivitySchema,
} from '@shared/core/chats/activity';
import {
  type ChatMentionSpan,
  type ChatMessage,
  type ChatMessagesPage,
  chatMessagesPageSchema,
  type ChatThreadMessagesPage,
  chatThreadMessagesPageSchema,
  chatCreatedSchema,
  chatErrorBodySchema,
  chatListSchema,
  chatSentSchema,
  type ChatSummary,
  chatSummarySchema,
  type ChatUpload,
  chatUploadSchema,
  chatAgentAddedSchema,
  type ChatCommand,
  type ChatMember,
  chatCommandListSchema,
  chatMemberListSchema,
  type WorkspaceMember,
  workspaceMemberSchema,
  agentCandidatesSchema,
} from '@shared/core/chats/chats';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * The gateway's `/chats` routes, called as the signed-in person. Every answer
 * is parsed against the contract before it goes anywhere; a refusal the
 * gateway coded is raised as a {@link ChatApiError} so the renderer can tell
 * "not a member" from "request reused" from a network failure.
 */

/** A refusal `/chats` answered with a code, such as `NOT_A_MEMBER` or `REQUEST_REUSED`. */
export class ChatApiError extends Error {
  constructor(
    readonly apiCode: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ChatApiError';
  }
}

/** The coded refusal inside a failed gateway call, or the call's own error. */
export function chatError(error: unknown): unknown {
  if (!(error instanceof GatewayError) || error.kind !== 'http' || !error.body) return error;
  try {
    const parsed = chatErrorBodySchema.safeParse(JSON.parse(error.body));
    if (parsed.success)
      return new ChatApiError(
        parsed.data.detail.code,
        parsed.data.detail.message,
        error.status ?? 0
      );
  } catch {
    // Not JSON: the gateway's own error stands.
  }
  return error;
}

async function call(
  server: SwitchServer,
  path: string,
  options: { method?: string; body?: unknown; formData?: FormData }
): Promise<Response> {
  try {
    return await gatewayFetch(server, path, { authenticated: true, ...options });
  } catch (error) {
    throw chatError(error);
  }
}

async function json<T>(
  server: SwitchServer,
  path: string,
  schema: z.ZodType<T>,
  options: { method?: string; body?: unknown; formData?: FormData } = {}
): Promise<T> {
  return schema.parse(await (await call(server, path, options)).json());
}

const room = (roomId: string) => `/chats/${encodeURIComponent(roomId)}`;

/** Each row parsed alone: a row that fails the contract is skipped with a warning, not the list. */
export function parseChatRows(rows: unknown[]): ChatSummary[] {
  return rows.flatMap((row) => {
    const parsed = chatSummarySchema.safeParse(row);
    if (parsed.success) return [parsed.data];
    log.warn('Skipped a chat that does not match the contract', {
      event: 'chat_row_invalid',
      roomId: (row as { roomId?: unknown } | null)?.roomId ?? null,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
    return [];
  });
}

export async function listChats(server: SwitchServer): Promise<ChatSummary[]> {
  return parseChatRows((await json(server, '/chats', chatListSchema)).chats);
}

export async function listArchivedChats(server: SwitchServer): Promise<ChatSummary[]> {
  return parseChatRows((await json(server, '/chats/archived', chatListSchema)).chats);
}

/**
 * One agent goes as `agentId`, which every server with chats accepts; only a
 * chat with several needs `agentIds`. Zero agents allowed; memberUserIds optional.
 */
export async function createChat(
  server: SwitchServer,
  input: {
    agentIds?: string[];
    memberUserIds?: string[];
    name: string | null;
    requestId: string;
    greeting: string | null;
    /** `group` makes a group even of one agent and nobody else. */
    kind?: 'group';
  }
): Promise<ChatSummary> {
  const agentIds = input.agentIds ?? [];
  const body: Record<string, string | string[]> = {
    requestId: input.requestId,
  };
  if (agentIds.length === 1) body.agentId = agentIds[0];
  else body.agentIds = agentIds;
  if (input.memberUserIds) body.memberUserIds = input.memberUserIds;
  if (input.name) body.name = input.name;
  if (input.greeting !== null) body.greeting = input.greeting;
  if (input.kind) body.kind = input.kind;
  return (await json(server, '/chats', chatCreatedSchema, { method: 'POST', body })).chat;
}

export async function fetchChatMessages(
  server: SwitchServer,
  roomId: string,
  page: { beforeSeq: number | null; limit: number }
): Promise<ChatMessagesPage> {
  const query = new URLSearchParams({ limit: String(page.limit) });
  if (page.beforeSeq !== null) query.set('beforeSeq', String(page.beforeSeq));
  return json(server, `${room(roomId)}/messages?${query}`, chatMessagesPageSchema);
}

export async function addChatAgent(
  server: SwitchServer,
  roomId: string,
  agentId: string
): Promise<ChatSummary> {
  return (
    await json(server, `${room(roomId)}/agents`, chatAgentAddedSchema, {
      method: 'POST',
      body: { agentId },
    })
  ).chat;
}

export async function removeChatAgent(
  server: SwitchServer,
  roomId: string,
  agentId: string
): Promise<void> {
  await call(server, `${room(roomId)}/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
}

export async function listChatMembers(server: SwitchServer, roomId: string): Promise<ChatMember[]> {
  return (await json(server, `${room(roomId)}/members`, chatMemberListSchema)).members;
}

/** The room commands a member can type in this room (`GET /chats/{room}/commands`). */
export async function listChatCommands(
  server: SwitchServer,
  roomId: string
): Promise<ChatCommand[]> {
  return (await json(server, `${room(roomId)}/commands`, chatCommandListSchema)).commands;
}

export async function addChatMember(
  server: SwitchServer,
  roomId: string,
  userId: string
): Promise<ChatMember[]> {
  return (
    await json(server, `${room(roomId)}/members`, chatMemberListSchema, {
      method: 'POST',
      body: { userId },
    })
  ).members;
}

export async function removeChatMember(
  server: SwitchServer,
  roomId: string,
  userId: string
): Promise<void> {
  await call(server, `${room(roomId)}/members/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
}

/** The workspace's roster, the people a chat can be opened to. */
export async function listWorkspaceMembers(
  server: SwitchServer,
  tenantId: string
): Promise<WorkspaceMember[]> {
  return json(
    server,
    `/tenants/${encodeURIComponent(tenantId)}/members`,
    workspaceMemberSchema.array()
  );
}

/** The ids of the agents the viewer may add to a new chat (`roomId` null) or to that chat. */
export async function listAgentCandidates(
  server: SwitchServer,
  roomId: string | null
): Promise<string[]> {
  const query = roomId === null ? '' : `?roomId=${encodeURIComponent(roomId)}`;
  return (await json(server, `/chats/agent-candidates${query}`, agentCandidatesSchema)).agentIds;
}

/** The viewer has been shown the chat through `seq`; the server never moves it back. */
export async function markChatRead(server: SwitchServer, roomId: string, seq: number) {
  await call(server, `${room(roomId)}/read`, { method: 'PUT', body: { seq } });
}

export async function sendChatMessage(
  server: SwitchServer,
  roomId: string,
  input: {
    requestId: string;
    body: string;
    threadRootId: string | null;
    uploadIds: string[];
    mentionAgentIds?: string[];
    mentionUserIds?: string[];
    mentionSpans?: ChatMentionSpan[];
  }
): Promise<ChatMessage[]> {
  return (
    await json(server, `${room(roomId)}/messages`, chatSentSchema, {
      method: 'POST',
      // One agent also goes as `mentionAgentId`, which a server from before
      // `mentionAgentIds` reads, so a rolling deploy still addresses it.
      // People and spans go only when there are any: a server without group
      // chats refuses them even empty.
      body: {
        requestId: input.requestId,
        body: input.body,
        threadRootId: input.threadRootId,
        uploadIds: input.uploadIds,
        ...(input.mentionAgentIds && { mentionAgentIds: input.mentionAgentIds }),
        ...(input.mentionAgentIds?.length === 1 && { mentionAgentId: input.mentionAgentIds[0] }),
        ...(input.mentionUserIds?.length && { mentionUserIds: input.mentionUserIds }),
        ...(input.mentionSpans?.length && { mentionSpans: input.mentionSpans }),
      },
    })
  ).messages;
}

export async function fetchThreadMessages(
  server: SwitchServer,
  roomId: string,
  rootId: string,
  page: { beforeSeq: number | null; limit: number }
): Promise<ChatThreadMessagesPage> {
  const query = new URLSearchParams({ limit: String(page.limit) });
  if (page.beforeSeq !== null) query.set('beforeSeq', String(page.beforeSeq));
  return json(
    server,
    `${room(roomId)}/threads/${encodeURIComponent(rootId)}/messages?${query}`,
    chatThreadMessagesPageSchema
  );
}

/** The room's turn steps and approval requests, as Switch stores them. */
export async function fetchRoomActivity(
  server: SwitchServer,
  roomId: string
): Promise<RoomActivity> {
  return json(server, `${room(roomId)}/activity`, roomActivitySchema);
}

/**
 * Post Stop, Reset or Compact to the room for an agent. The answer is its
 * command id: the command is posted, not done, and the agent answers it in a
 * thread rooted there.
 */
export async function sendChatControl(
  server: SwitchServer,
  roomId: string,
  input: {
    requestId: string;
    agentId: string;
    command: ChatControlCommand;
    /** The message a `retry` runs again; null for every other control. */
    messageId: string | null;
  }
): Promise<string> {
  return (
    await json(server, `${room(roomId)}/controls`, chatControlAcceptedSchema, {
      method: 'POST',
      body: {
        requestId: input.requestId,
        agentId: input.agentId,
        command: input.command,
        ...(input.messageId !== null ? { messageId: input.messageId } : {}),
      },
    })
  ).commandId;
}

/** Ask core to have the agent's controller start its session for the room; a hint, accepted at once. */
export async function warmChatAgent(server: SwitchServer, roomId: string, agentId: string) {
  await call(server, `${room(roomId)}/warm`, { method: 'POST', body: { agentId } });
}

/** Answer an agent's approval request as the signed-in person. */
export async function answerChatApproval(
  server: SwitchServer,
  request: { agentId: string; sessionId: string; requestId: string },
  answer: ChatApprovalAnswer
): Promise<ChatApproval> {
  const path = [request.agentId, request.sessionId, 'approvals', request.requestId]
    .map(encodeURIComponent)
    .join('/');
  return json(server, `/agent-sessions/${path}/answer`, chatApprovalSchema, {
    method: 'POST',
    body: answer,
  });
}

export async function uploadChatAttachment(
  server: SwitchServer,
  roomId: string,
  file: { uploadId: string; name: string; mimeType: string; bytes: Uint8Array }
): Promise<ChatUpload> {
  const form = new FormData();
  form.set('uploadId', file.uploadId);
  form.set('file', new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.name);
  return json(server, `${room(roomId)}/attachments`, chatUploadSchema, {
    method: 'POST',
    formData: form,
  });
}

export async function fetchChatMedia(
  server: SwitchServer,
  roomId: string,
  uri: string
): Promise<{ mimeType: string; bytes: Uint8Array }> {
  const response = await call(server, `${room(roomId)}/media?${new URLSearchParams({ uri })}`, {});
  return {
    mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

export async function archiveChat(server: SwitchServer, roomId: string): Promise<void> {
  await call(server, `${room(roomId)}/archive`, { method: 'POST' });
}

export async function unarchiveChat(server: SwitchServer, roomId: string): Promise<void> {
  await call(server, `${room(roomId)}/unarchive`, { method: 'POST' });
}

/** Rename uses the room route: a chat's name is its room's name. */
export async function renameChat(
  server: SwitchServer,
  roomId: string,
  name: string
): Promise<void> {
  await call(server, `/rooms/${encodeURIComponent(roomId)}`, { method: 'PATCH', body: { name } });
}
