import type { ChatMessage } from '@shared/core/chats/chats';

/**
 * Threads are shown inline: every message in sequence order, and a reply
 * carries a chip naming the message it answers ("↳ reply to …"), which
 * scrolls to it when clicked.
 */

const SNIPPET = 80;

/** A message's text, flattened to one line and cut to a chip's length. */
export function snippetOf(message: Pick<ChatMessage, 'body' | 'attachments'>): string {
  const text = message.body.replace(/\s+/g, ' ').trim();
  if (!text) return message.attachments[0]?.filename ?? 'an attachment';
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET - 1)}…` : text;
}

export type ThreadChip = {
  rootId: string;
  /** The root's text, or null while it is not loaded (older than what is shown). */
  snippet: string | null;
  label: string;
};

export function threadChip(
  message: Pick<ChatMessage, 'threadRootId' | 'messageId'>,
  find: (messageId: string) => ChatMessage | undefined
): ThreadChip | null {
  const rootId = message.threadRootId;
  if (!rootId || rootId === message.messageId) return null;
  const root = find(rootId);
  const snippet = root ? snippetOf(root) : null;
  return {
    rootId,
    snippet,
    label: snippet === null ? '↳ reply to an earlier message' : `↳ reply to ${snippet}`,
  };
}

/** The DOM id a message is rendered under, for scrolling to it. */
export function messageAnchorId(messageId: string): string {
  return `chat-message-${messageId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}
