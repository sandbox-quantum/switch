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
  type ChatMessage,
  type ChatMessagesPage,
  chatMessagesPageSchema,
  chatCreatedSchema,
  chatErrorBodySchema,
  chatListSchema,
  chatSentSchema,
  type ChatSummary,
  chatSummarySchema,
  type ChatUpload,
  chatUploadSchema,
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

/**
 * One agent goes as `agentId`, which every server with chats accepts; only a
 * chat with several needs `agentIds`.
 */
export async function createChat(
  server: SwitchServer,
  input: { agentIds: string[]; name: string | null; requestId: string; greeting: string | null }
): Promise<ChatSummary> {
  const body: Record<string, string | string[]> = {
    ...(input.agentIds.length === 1
      ? { agentId: input.agentIds[0] }
      : { agentIds: input.agentIds }),
    requestId: input.requestId,
  };
  if (input.name) body.name = input.name;
  // What its one agent says as it joins, in place of its usual line.
  if (input.greeting !== null) body.greeting = input.greeting;
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

export async function sendChatMessage(
  server: SwitchServer,
  roomId: string,
  input: {
    requestId: string;
    body: string;
    threadRootId: string | null;
    uploadIds: string[];
  }
): Promise<ChatMessage[]> {
  return (
    await json(server, `${room(roomId)}/messages`, chatSentSchema, {
      method: 'POST',
      body: input,
    })
  ).messages;
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
  input: { requestId: string; agentId: string; command: ChatControlCommand }
): Promise<string> {
  return (
    await json(server, `${room(roomId)}/controls`, chatControlAcceptedSchema, {
      method: 'POST',
      body: input,
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

export async function setChatHidden(
  server: SwitchServer,
  roomId: string,
  hidden: boolean
): Promise<void> {
  await call(server, `${room(roomId)}/hidden`, { method: hidden ? 'PUT' : 'DELETE' });
}

/** Rename uses the room route: a chat's name is its room's name. */
export async function renameChat(
  server: SwitchServer,
  roomId: string,
  name: string
): Promise<void> {
  await call(server, `/rooms/${encodeURIComponent(roomId)}`, { method: 'PATCH', body: { name } });
}
