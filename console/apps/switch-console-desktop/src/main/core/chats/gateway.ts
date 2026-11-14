import {
  ChatsClient,
  type ChatsRequest,
  parseChatRows as parseRows,
} from '@switch-console/chat-ui/client/chats-client';
import { chatErrorBodySchema } from '@switch-console/chat-ui/contracts/chats';
import { GatewayError, gatewayFetch } from '@main/core/switch-servers/gateway-client';
import { log } from '@main/lib/logger';
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

async function call(server: SwitchServer, path: string, options: ChatsRequest): Promise<Response> {
  try {
    return await gatewayFetch(server, path, { authenticated: true, ...options });
  } catch (error) {
    throw chatError(error);
  }
}

function client(server: SwitchServer): ChatsClient {
  return new ChatsClient({
    call: (path, request) => call(server, path, request),
    warn: (message, context) => log.warn(message, context),
  });
}

/** Each row parsed alone: a row that fails the contract is skipped with a warning, not the list. */
export function parseChatRows(rows: unknown[]) {
  return parseRows((message, context) => log.warn(message, context), rows);
}

export const listChats = (server: SwitchServer) => client(server).listChats();

export const listArchivedChats = (server: SwitchServer) => client(server).listArchivedChats();

export const createChat = (server: SwitchServer, input: Parameters<ChatsClient['createChat']>[0]) =>
  client(server).createChat(input);

export const fetchChatMessages = (
  server: SwitchServer,
  roomId: string,
  page: Parameters<ChatsClient['fetchChatMessages']>[1]
) => client(server).fetchChatMessages(roomId, page);

export const addChatAgent = (server: SwitchServer, roomId: string, agentId: string) =>
  client(server).addChatAgent(roomId, agentId);

export const removeChatAgent = (server: SwitchServer, roomId: string, agentId: string) =>
  client(server).removeChatAgent(roomId, agentId);

export const listChatMembers = (server: SwitchServer, roomId: string) =>
  client(server).listChatMembers(roomId);

export const listChatCommands = (server: SwitchServer, roomId: string) =>
  client(server).listChatCommands(roomId);

export const addChatMember = (server: SwitchServer, roomId: string, userId: string) =>
  client(server).addChatMember(roomId, userId);

export const removeChatMember = (server: SwitchServer, roomId: string, userId: string) =>
  client(server).removeChatMember(roomId, userId);

export const listWorkspaceMembers = (server: SwitchServer, tenantId: string) =>
  client(server).listWorkspaceMembers(tenantId);

export const listAgentCandidates = (
  server: SwitchServer,
  roomId: string | null,
  groupId: string | null = null
) => client(server).listAgentCandidates(roomId, groupId);

export const markChatRead = (server: SwitchServer, roomId: string, seq: number) =>
  client(server).markChatRead(roomId, seq);

export const sendChatMessage = (
  server: SwitchServer,
  roomId: string,
  input: Parameters<ChatsClient['sendChatMessage']>[1]
) => client(server).sendChatMessage(roomId, input);

export const fetchThreadMessages = (
  server: SwitchServer,
  roomId: string,
  rootId: string,
  page: Parameters<ChatsClient['fetchThreadMessages']>[2]
) => client(server).fetchThreadMessages(roomId, rootId, page);

export const fetchRoomActivity = (server: SwitchServer, roomId: string) =>
  client(server).fetchRoomActivity(roomId);

export const sendChatControl = (
  server: SwitchServer,
  roomId: string,
  input: Parameters<ChatsClient['sendChatControl']>[1]
) => client(server).sendChatControl(roomId, input);

export const warmChatAgent = (server: SwitchServer, roomId: string, agentId: string) =>
  client(server).warmChatAgent(roomId, agentId);

export const answerChatApproval = (
  server: SwitchServer,
  request: Parameters<ChatsClient['answerChatApproval']>[0],
  answer: Parameters<ChatsClient['answerChatApproval']>[1]
) => client(server).answerChatApproval(request, answer);

export const uploadChatAttachment = (
  server: SwitchServer,
  roomId: string,
  file: Parameters<ChatsClient['uploadChatAttachment']>[1]
) => client(server).uploadChatAttachment(roomId, file);

export const fetchChatMedia = (server: SwitchServer, roomId: string, uri: string) =>
  client(server).fetchChatMedia(roomId, uri);

export const archiveChat = (server: SwitchServer, roomId: string) =>
  client(server).archiveChat(roomId);

export const unarchiveChat = (server: SwitchServer, roomId: string) =>
  client(server).unarchiveChat(roomId);

export const renameChat = (server: SwitchServer, roomId: string, name: string) =>
  client(server).renameChat(roomId, name);
