import { z } from 'zod';
import { GatewayError, gatewayFetch } from '@main/core/switch-servers/gateway-client';
import {
  type ChatMember,
  chatMembersSchema,
  type ChatMessage,
  type ChatMessagesPage,
  chatMessagesPageSchema,
  chatCreatedSchema,
  chatErrorBodySchema,
  chatListSchema,
  chatSentSchema,
  type ChatSummary,
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

export async function listChats(server: SwitchServer): Promise<ChatSummary[]> {
  return (await json(server, '/chats', chatListSchema)).chats;
}

export async function createChat(
  server: SwitchServer,
  input: { agentId: string; name: string | null; requestId: string }
): Promise<ChatSummary> {
  const body: Record<string, string> = { agentId: input.agentId, requestId: input.requestId };
  if (input.name) body.name = input.name;
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
    mentionAgentId: string | null;
  }
): Promise<ChatMessage[]> {
  return (
    await json(server, `${room(roomId)}/messages`, chatSentSchema, {
      method: 'POST',
      body: input,
    })
  ).messages;
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

export async function fetchChatMembers(
  server: SwitchServer,
  roomId: string
): Promise<ChatMember[]> {
  return (await json(server, `${room(roomId)}/members`, chatMembersSchema)).members;
}

export async function inviteChatMember(
  server: SwitchServer,
  roomId: string,
  userId: string
): Promise<ChatMember[]> {
  return (
    await json(server, `${room(roomId)}/members`, chatMembersSchema, {
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

export async function setChatHidden(
  server: SwitchServer,
  roomId: string,
  hidden: boolean
): Promise<void> {
  await call(server, `${room(roomId)}/hidden`, { method: hidden ? 'PUT' : 'DELETE' });
}

export async function archiveChat(server: SwitchServer, roomId: string): Promise<void> {
  await call(server, `${room(roomId)}/archive`, { method: 'POST' });
}

/**
 * The synthetic account that owns agents registered with the deployment's
 * bootstrap key (`BOOTSTRAP_OWNER_EMAIL` in core's `registration_bootstrap.py`).
 * It never signs in, so it is nobody to invite. Core holds this address fixed
 * and refuses to start if any other account claims it.
 */
const BOOTSTRAP_OWNER_EMAIL = 'agent-bootstrap@switch.local';

const tenantMembersSchema = z.array(
  z.object({ user_id: z.string(), name: z.string(), email: z.string() })
);

/** The workspace's people, whom a chat's managers may invite. */
export async function fetchTenantMembers(
  server: SwitchServer,
  tenantId: string
): Promise<{ userId: string; name: string }[]> {
  const members = await json(
    server,
    `/tenants/${encodeURIComponent(tenantId)}/members`,
    tenantMembersSchema
  );
  return members
    .filter((member) => member.email !== BOOTSTRAP_OWNER_EMAIL)
    .map((member) => ({ userId: member.user_id, name: member.name || member.email }));
}

/** Rename uses the room route: a chat's name is its room's name. */
export async function renameChat(
  server: SwitchServer,
  roomId: string,
  name: string
): Promise<void> {
  await call(server, `/rooms/${encodeURIComponent(roomId)}`, { method: 'PATCH', body: { name } });
}
