import type { MentionToken } from '../mentions';

/**
 * An unsent message: its text and the mentions picked in it, with who each names.
 * `pendingRequestId` is the request id it was sent under when the window went
 * before the server answered: the message may have landed, so the draft is
 * dropped if it did, and sent again under that id if not, which the server
 * takes once.
 */
export type ChatDraft = {
  text: string;
  mentions: MentionToken[];
  pendingRequestId: string | null;
  /** The thread that send replied in; null for the room itself. */
  pendingThreadRootId: string | null;
};

const PREFIX = 'chat-draft:';

/** Drafts whose account or workspace is not known yet: kept for this session only. */
const unscoped = new Map<string, ChatDraft>();

/**
 * Where a room's draft is kept: one per account, workspace and room, so a draft
 * never shows up in another account's or workspace's chat. Until the account and
 * workspace are known it is kept in memory only, by server and room.
 */
export function chatDraftKey(scope: {
  serverId: string;
  userId: string | null;
  workspaceId: string | null;
  roomId: string;
}): string {
  if (scope.userId === null || scope.workspaceId === null) {
    return JSON.stringify([scope.serverId, scope.roomId]);
  }
  return `${PREFIX}${JSON.stringify([scope.serverId, scope.userId, scope.workspaceId, scope.roomId])}`;
}

function isMention(value: unknown): value is MentionToken {
  if (typeof value !== 'object' || value === null) return false;
  const mention = value as Record<string, unknown>;
  return (
    (mention.kind === 'agent' || mention.kind === 'person') &&
    typeof mention.id === 'string' &&
    Number.isInteger(mention.start) &&
    Number.isInteger(mention.end)
  );
}

/** The draft kept under `key` (across reloads and restarts once scoped); null when there is none or it is unreadable. */
export function readChatDraft(key: string): ChatDraft | null {
  if (!key.startsWith(PREFIX)) return unscoped.get(key) ?? null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { text, mentions, pendingRequestId, pendingThreadRootId } = parsed as Record<
    string,
    unknown
  >;
  if (typeof text !== 'string' || !Array.isArray(mentions)) return null;
  return {
    text,
    pendingRequestId: typeof pendingRequestId === 'string' ? pendingRequestId : null,
    pendingThreadRootId: typeof pendingThreadRootId === 'string' ? pendingThreadRootId : null,
    mentions: mentions.filter(
      (mention): mention is MentionToken => isMention(mention) && mention.end <= text.length
    ),
  };
}

/** Keep `draft` under `key`; an empty one is forgotten. */
export function writeChatDraft(key: string, draft: ChatDraft): void {
  if (!key.startsWith(PREFIX)) {
    if (draft.text === '') unscoped.delete(key);
    else unscoped.set(key, draft);
  } else if (draft.text === '') localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(draft));
}

/** Move the draft kept under `from` to `to`: an unsaved chat's, to the room it became. */
export function moveChatDraft(from: string, to: string): void {
  const draft = readChatDraft(from);
  if (!draft) return;
  writeChatDraft(to, draft);
  writeChatDraft(from, { ...draft, text: '' });
}

/**
 * Where an agent's unsaved chat's create request id is kept across restarts:
 * one per account, workspace and agent, like drafts; null until the account and
 * workspace are known, when it is kept for this session only.
 */
export function unsavedChatKey(scope: {
  serverId: string;
  userId: string | null;
  workspaceId: string | null;
  agentId: string;
}): string | null {
  if (scope.userId === null || scope.workspaceId === null) return null;
  return `unsaved-chat:${JSON.stringify([scope.serverId, scope.userId, scope.workspaceId, scope.agentId])}`;
}
