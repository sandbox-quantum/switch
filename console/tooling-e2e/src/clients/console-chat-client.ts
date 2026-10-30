import { randomUUID } from 'node:crypto';
import type { SwitchClient } from './switch-client.ts';

/**
 * The *human* half of the loop: the gateway's `/chats` routes, which is what
 * Switch Console itself calls to post into a room and read it back
 * (`apps/switch-console-desktop/src/main/core/chats/gateway.ts`). It sends
 * through the `SwitchClient`'s gateway session, so the gateway admin is the
 * human in every room, and the read-only guard and request tags apply.
 */

export interface ChatSender {
  clientId: string;
  name: string;
  kind: string;
  agentId: string | null;
  userId: string | null;
}

export interface ChatMessage {
  messageId: string;
  seq: number;
  roomId: string;
  sentAt: string;
  sender: ChatSender;
  body: string;
  threadRootId: string | null;
}

/** An agent's open question or permission request — what Console draws as a card. */
export interface ChatRequest {
  agentId: string;
  sessionId: string;
  requestId: string;
  kind: 'approval' | 'questions';
  state: string;
  title: string;
  detail: string | null;
  options: { id: string; label: string; decision: string }[];
  questions: {
    id: string;
    title: string;
    prompt: string;
    options: { id: string; label: string; description: string | null }[];
  }[];
}

/** One step of an agent's turn; a `turn` item's status is `queued`/`running` while it is live. */
export interface ChatActivityItem {
  agentId: string;
  turnId: string;
  kind: string;
  status: string;
}

export type ChatRequestAnswer =
  | { answer: string }
  | {
      answers: { questionId: string; selectedOptionIds: string[]; customText: string | null }[];
    };

export interface ChatUser {
  id: string;
  name: string;
}

export class ConsoleChatClient {
  private readonly switchClient: SwitchClient;

  constructor(switchClient: SwitchClient) {
    this.switchClient = switchClient;
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.switchClient.gateway<T>(method, path, body);
  }

  /** `GET /gateway/auth/me` — the person the harness posts as. */
  async me(): Promise<ChatUser> {
    const user = await this.request<{ id: string; name: string }>('GET', '/auth/me');
    return { id: user.id, name: user.name };
  }

  /**
   * `POST /gateway/chats` as a group, so a message reaches an agent only when
   * it names it, as in a shared channel.
   */
  async createGroupChat(params: { name: string; agentIds: string[] }): Promise<string> {
    const body = await this.request<{ chat: { roomId: string } }>('POST', '/chats', {
      agentIds: params.agentIds,
      name: params.name,
      kind: 'group',
      requestId: randomUUID(),
    });
    return body.chat.roomId;
  }

  /** `POST /gateway/chats/{room}/members` — put a person of the workspace in the room (a manager's call). */
  async addMember(roomId: string, userId: string): Promise<void> {
    await this.request('POST', `/chats/${encodeURIComponent(roomId)}/members`, { userId });
  }

  /** `POST /gateway/chats/{room}/messages` — post as the signed-in person. */
  async send(
    roomId: string,
    body: string,
    threadRootId: string | null = null
  ): Promise<ChatMessage> {
    const sent = await this.request<{ messages: ChatMessage[] }>(
      'POST',
      `/chats/${encodeURIComponent(roomId)}/messages`,
      { requestId: randomUUID(), body, threadRootId, uploadIds: [] }
    );
    const first = sent.messages[0];
    if (!first) throw new Error(`Sending to ${roomId} returned no message`);
    return first;
  }

  /**
   * `POST /gateway/chats/{room}/controls` — the Console's Stop button, which
   * posts `!interrupt @agent` into the room as the person.
   */
  async control(
    roomId: string,
    agentId: string,
    command: 'interrupt' | 'reset' | 'compact'
  ): Promise<string> {
    const body = await this.request<{ commandId: string }>(
      'POST',
      `/chats/${encodeURIComponent(roomId)}/controls`,
      { requestId: randomUUID(), agentId, command }
    );
    return body.commandId;
  }

  /** `GET /gateway/chats/{room}/activity` — the room's turn steps and requests, in every state. */
  async activity(roomId: string): Promise<{ items: ChatActivityItem[]; approvals: ChatRequest[] }> {
    return this.request('GET', `/chats/${encodeURIComponent(roomId)}/activity`);
  }

  async requests(roomId: string): Promise<ChatRequest[]> {
    return (await this.activity(roomId)).approvals;
  }

  /** `POST /gateway/agent-sessions/{agent}/{session}/approvals/{request}/answer` — the card's Submit. */
  async answer(request: ChatRequest, answer: ChatRequestAnswer): Promise<void> {
    const path = [request.agentId, request.sessionId, 'approvals', request.requestId]
      .map(encodeURIComponent)
      .join('/');
    await this.request('POST', `/agent-sessions/${path}/answer`, answer);
  }

  /**
   * Wait for an open request of `kind` from `agentId` in the room whose id is
   * not in `known` (the ids present before the scenario asked), or null at the deadline.
   */
  async waitForOpenRequest(params: {
    roomId: string;
    agentId: string;
    kind: ChatRequest['kind'];
    known: Set<string>;
    deadlineMs: number;
  }): Promise<ChatRequest | null> {
    const until = Date.now() + params.deadlineMs;
    for (;;) {
      const match = (await this.requests(params.roomId)).find(
        (request) =>
          request.state === 'open' &&
          !params.known.has(request.requestId) &&
          request.agentId === params.agentId &&
          request.kind === params.kind
      );
      if (match) return match;
      if (Date.now() >= until) return null;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  /** `GET /gateway/chats/{room}/messages` — messages after `afterSeq`, oldest first. */
  async messagesAfter(roomId: string, afterSeq: number): Promise<ChatMessage[]> {
    // shortcut: reads only the newest 200, enough for one scenario's window.
    const page = await this.request<{ messages: ChatMessage[] }>(
      'GET',
      `/chats/${encodeURIComponent(roomId)}/messages?limit=200`
    );
    return page.messages.filter((message) => message.seq > afterSeq);
  }

  /**
   * Wait for a message from `fromAgentId` matching `predicate`. Returns the
   * whole transcript seen either way, so a failure can report what was said.
   */
  async waitForMessage(params: {
    roomId: string;
    fromAgentId: string;
    predicate: (message: ChatMessage) => boolean;
    afterSeq: number;
    deadlineMs: number;
  }): Promise<{ match: ChatMessage | null; transcript: ChatMessage[] }> {
    const until = Date.now() + params.deadlineMs;
    for (;;) {
      const transcript = await this.messagesAfter(params.roomId, params.afterSeq);
      const match = transcript.find(
        (message) => message.sender.agentId === params.fromAgentId && params.predicate(message)
      );
      if (match) return { match, transcript };
      if (Date.now() >= until) return { match: null, transcript };
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}
