import { defineEvent } from '@shared/lib/ipc/events';
import type { ChatActivityItem, ChatApproval } from './activity';
import type { ChatMessage, ChatRemovalReason, ChatStreamState, ChatSummary } from './chats';

/**
 * The chats live feed, pushed by the main process. Every event names the
 * server it came from: one feed runs per server and tenant, and a renderer
 * scoped to another server ignores it.
 */
export const chatMessageChannel = defineEvent<{ serverId: string; message: ChatMessage }>(
  'chat:message'
);

/** A chat entered the list (new membership, or it qualifies again) or its summary changed. */
export const chatSummaryChannel = defineEvent<{ serverId: string; chat: ChatSummary }>(
  'chat:summary'
);

/**
 * The room left the person's list. `access`: they lost it (removed, left,
 * lost their tenant role, or it was archived). `unlisted`: still a member, so
 * an open chat keeps reading and posting; it is only off the list.
 */
export const chatRemovedChannel = defineEvent<{
  serverId: string;
  roomId: string;
  reason: ChatRemovalReason;
}>('chat:removed');

export const chatStreamStateChannel = defineEvent<{
  serverId: string;
  state: ChatStreamState;
  /** Why the feed is offline or retrying, when it is. */
  detail: string | null;
}>('chat:stream-state');

/**
 * Everything held for the server's chats is stale: the person signed out or
 * the tenant changed. Drop cursors, messages and media for it.
 */
export const chatResetChannel = defineEvent<{ serverId: string }>('chat:reset');

/** One turn step from the server's activity feed, for a room the person may read. */
export const chatActivityChannel = defineEvent<{ serverId: string; item: ChatActivityItem }>(
  'chat:activity'
);

/** An approval request, in whatever state it is now. */
export const chatApprovalChannel = defineEvent<{ serverId: string; approval: ChatApproval }>(
  'chat:approval'
);

/**
 * The activity feed (re)connected or may have missed changes: reload the
 * activity snapshot of every room shown.
 */
export const chatActivityResyncChannel = defineEvent<{ serverId: string }>('chat:activity-resync');

/** The activity feed dropped (`offline`) or is back (`live`); same shape as {@link chatStreamStateChannel}. */
export const chatActivityStateChannel = defineEvent<{
  serverId: string;
  state: ChatStreamState;
  detail: string | null;
}>('chat:activity-state');
