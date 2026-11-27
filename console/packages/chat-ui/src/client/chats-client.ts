import type { z } from 'zod';
import {
  type ChatApproval,
  type ChatApprovalAnswer,
  chatApprovalSchema,
  chatControlAcceptedSchema,
  type ChatControlCommand,
  type RoomActivity,
  roomActivitySchema,
} from '../contracts/activity';
import {
  agentCandidatesSchema,
  chatAgentAddedSchema,
  type ChatCommand,
  chatCommandListSchema,
  chatCreatedSchema,
  chatListSchema,
  type ChatMember,
  chatMemberListSchema,
  type ChatMentionSpan,
  type ChatMessage,
  type ChatMessagesPage,
  chatMessagesPageSchema,
  chatSentSchema,
  type ChatSummary,
  chatSummarySchema,
  type ChatThreadMessagesPage,
  chatThreadMessagesPageSchema,
  type ChatUpload,
  chatUploadSchema,
  type WorkspaceMember,
  workspaceMemberSchema,
} from '../contracts/chats';

type Warn = (message: string, context: Record<string, unknown>) => void;

export type ChatsRequest = { method?: string; body?: unknown; formData?: FormData };

export type ChatsClientDeps = {
  /**
   * Calls a gateway route (`/chats/...`) as the signed-in person and returns
   * its answer, throwing for a refusal or an unreachable server.
   */
  call: (path: string, request: ChatsRequest) => Promise<Response>;
  warn: Warn;
};

/** Who may see a chat. */
export type RoomAccess = 'public' | 'private';

const room = (roomId: string) => `/chats/${encodeURIComponent(roomId)}`;

/** Each row parsed alone: a row that fails the contract is skipped with a warning, not the list. */
export function parseChatRows(warn: Warn, rows: unknown[]): ChatSummary[] {
  return rows.flatMap((row) => {
    const parsed = chatSummarySchema.safeParse(row);
    if (parsed.success) return [parsed.data];
    warn('Skipped a chat that does not match the contract', {
      event: 'chat_row_invalid',
      roomId: (row as { roomId?: unknown } | null)?.roomId ?? null,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
    return [];
  });
}

/**
 * The gateway's `/chats` routes, called as the signed-in person. Every answer
 * is parsed against the contract before it goes anywhere. How a route is
 * reached, and what a refusal is raised as, is the caller's `call`: Console's
 * main process through its stored sign-in, the dashboard with the browser's
 * cookie.
 */
export class ChatsClient {
  constructor(private readonly deps: ChatsClientDeps) {}

  private call(path: string, request: ChatsRequest): Promise<Response> {
    return this.deps.call(path, request);
  }

  private async json<T>(
    path: string,
    schema: z.ZodType<T>,
    request: ChatsRequest = {}
  ): Promise<T> {
    return schema.parse(await (await this.call(path, request)).json());
  }

  async listChats(): Promise<ChatSummary[]> {
    return parseChatRows(this.deps.warn, (await this.json('/chats', chatListSchema)).chats);
  }

  async listArchivedChats(): Promise<ChatSummary[]> {
    return parseChatRows(
      this.deps.warn,
      (await this.json('/chats/archived', chatListSchema)).chats
    );
  }

  /**
   * One agent goes as `agentId`, which every server with chats accepts; only a
   * chat with several needs `agentIds`. Zero agents allowed; memberUserIds optional.
   */
  async createChat(input: {
    agentIds?: string[];
    memberUserIds?: string[];
    name: string | null;
    requestId: string;
    greeting: string | null;
    bridgeId?: string | null;
    /** `group` makes a group even of one agent and nobody else. */
    kind?: 'group';
    /** Only finish the create already made under `requestId`; none is a `NO_SUCH_OPERATION` 404. */
    resumeOnly?: boolean;
    /** The room's own settings, each sent only when set; a server before them ignores them. */
    description?: string;
    instructions?: string;
    groupId?: string | null;
    /** Null or absent leaves the chat private. */
    access?: RoomAccess | null;
  }): Promise<ChatSummary> {
    const agentIds = input.agentIds ?? [];
    const body: Record<string, string | string[] | boolean> = {
      requestId: input.requestId,
    };
    if (agentIds.length === 1) body.agentId = agentIds[0];
    else body.agentIds = agentIds;
    if (input.memberUserIds) body.memberUserIds = input.memberUserIds;
    if (input.name) body.name = input.name;
    if (input.greeting !== null) body.greeting = input.greeting;
    if (input.bridgeId) body.bridgeId = input.bridgeId;
    if (input.kind) body.kind = input.kind;
    if (input.resumeOnly) body.resumeOnly = true;
    if (input.description) body.description = input.description;
    if (input.instructions) body.instructions = input.instructions;
    if (input.groupId) body.groupId = input.groupId;
    // Who may see it; changing it is its owner's and admins' either way, so it
    // is stored write-private (the server wants both, or neither).
    if (input.access) {
      body.readVisibility = input.access;
      body.writeVisibility = 'private';
    }
    return (await this.json('/chats', chatCreatedSchema, { method: 'POST', body })).chat;
  }

  async fetchChatMessages(
    roomId: string,
    page: { beforeSeq: number | null; limit: number }
  ): Promise<ChatMessagesPage> {
    const query = new URLSearchParams({ limit: String(page.limit) });
    if (page.beforeSeq !== null) query.set('beforeSeq', String(page.beforeSeq));
    return this.json(`${room(roomId)}/messages?${query}`, chatMessagesPageSchema);
  }

  async addChatAgent(roomId: string, agentId: string): Promise<ChatSummary> {
    return (
      await this.json(`${room(roomId)}/agents`, chatAgentAddedSchema, {
        method: 'POST',
        body: { agentId },
      })
    ).chat;
  }

  async removeChatAgent(roomId: string, agentId: string): Promise<void> {
    await this.call(`${room(roomId)}/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
  }

  async listChatMembers(roomId: string): Promise<ChatMember[]> {
    return (await this.json(`${room(roomId)}/members`, chatMemberListSchema)).members;
  }

  /** The room commands a member can type in this room (`GET /chats/{room}/commands`). */
  async listChatCommands(roomId: string): Promise<ChatCommand[]> {
    return (await this.json(`${room(roomId)}/commands`, chatCommandListSchema)).commands;
  }

  async addChatMember(roomId: string, userId: string): Promise<ChatMember[]> {
    return (
      await this.json(`${room(roomId)}/members`, chatMemberListSchema, {
        method: 'POST',
        body: { userId },
      })
    ).members;
  }

  async removeChatMember(roomId: string, userId: string): Promise<void> {
    await this.call(`${room(roomId)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
  }

  /** The workspace's roster, the people a chat can be opened to. */
  async listWorkspaceMembers(tenantId: string): Promise<WorkspaceMember[]> {
    return this.json(
      `/tenants/${encodeURIComponent(tenantId)}/members`,
      workspaceMemberSchema.array()
    );
  }

  /** The ids of the agents the viewer may add to a new chat (`roomId` null) or to that chat. */
  /** `groupId`: for a new chat, the group it will be filed in, whose rules then apply. */
  async listAgentCandidates(
    roomId: string | null,
    groupId: string | null = null
  ): Promise<string[]> {
    const query =
      roomId !== null
        ? `?roomId=${encodeURIComponent(roomId)}`
        : groupId !== null
          ? `?groupId=${encodeURIComponent(groupId)}`
          : '';
    return (await this.json(`/chats/agent-candidates${query}`, agentCandidatesSchema)).agentIds;
  }

  /** The viewer has been shown the chat through `seq`; the server never moves it back. */
  async markChatRead(roomId: string, seq: number) {
    await this.call(`${room(roomId)}/read`, { method: 'PUT', body: { seq } });
  }

  async sendChatMessage(
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
      await this.json(`${room(roomId)}/messages`, chatSentSchema, {
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

  async fetchThreadMessages(
    roomId: string,
    rootId: string,
    page: { beforeSeq: number | null; limit: number }
  ): Promise<ChatThreadMessagesPage> {
    const query = new URLSearchParams({ limit: String(page.limit) });
    if (page.beforeSeq !== null) query.set('beforeSeq', String(page.beforeSeq));
    return this.json(
      `${room(roomId)}/threads/${encodeURIComponent(rootId)}/messages?${query}`,
      chatThreadMessagesPageSchema
    );
  }

  /** The room's turn steps and approval requests, as Switch stores them. */
  async fetchRoomActivity(roomId: string): Promise<RoomActivity> {
    return this.json(`${room(roomId)}/activity`, roomActivitySchema);
  }

  /**
   * Post Stop, Reset or Compact to the room for an agent. The answer is its
   * command id: the command is posted, not done, and the agent answers it in a
   * thread rooted there.
   */
  async sendChatControl(
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
      await this.json(`${room(roomId)}/controls`, chatControlAcceptedSchema, {
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
  async warmChatAgent(roomId: string, agentId: string) {
    await this.call(`${room(roomId)}/warm`, { method: 'POST', body: { agentId } });
  }

  /** Answer an agent's approval request as the signed-in person. */
  async answerChatApproval(
    request: { agentId: string; sessionId: string; requestId: string },
    answer: ChatApprovalAnswer
  ): Promise<ChatApproval> {
    const path = [request.agentId, request.sessionId, 'approvals', request.requestId]
      .map(encodeURIComponent)
      .join('/');
    return this.json(`/agent-sessions/${path}/answer`, chatApprovalSchema, {
      method: 'POST',
      body: answer,
    });
  }

  async uploadChatAttachment(
    roomId: string,
    file: { uploadId: string; name: string; mimeType: string; bytes: Uint8Array }
  ): Promise<ChatUpload> {
    const form = new FormData();
    form.set('uploadId', file.uploadId);
    form.set('file', new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.name);
    return this.json(`${room(roomId)}/attachments`, chatUploadSchema, {
      method: 'POST',
      formData: form,
    });
  }

  async fetchChatMedia(
    roomId: string,
    uri: string
  ): Promise<{ mimeType: string; bytes: Uint8Array }> {
    const response = await this.call(`${room(roomId)}/media?${new URLSearchParams({ uri })}`, {});
    return {
      mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }

  async archiveChat(roomId: string): Promise<void> {
    await this.call(`${room(roomId)}/archive`, { method: 'POST' });
  }

  async unarchiveChat(roomId: string): Promise<void> {
    await this.call(`${room(roomId)}/unarchive`, { method: 'POST' });
  }

  /** Rename uses the room route: a chat's name is its room's name. */
  async renameChat(roomId: string, name: string): Promise<void> {
    await this.call(`/rooms/${encodeURIComponent(roomId)}`, { method: 'PATCH', body: { name } });
  }
}
