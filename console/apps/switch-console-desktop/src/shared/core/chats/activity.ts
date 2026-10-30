import { z } from 'zod';

/**
 * What a chat shows of its agents' work. Turns, tool rows and approval
 * requests come from Switch's activity feed, the same rows the platforms draw
 * their progress messages from. Where an agent's session runs as seen from
 * this machine (a local or SSH host) is looked up only for what the host
 * alone keeps — reasoning and full tool input and output — and for restarting
 * the session.
 */

export type ChatActivityHostTarget = 'local' | 'ssh';

export type ChatActivityUnavailableReason =
  /** Not a local agent here. */
  | 'not-on-this-machine'
  /** The agent's watcher runs, but no session of it is placed in this room. */
  | 'not-placed'
  /** The agent's watcher could not be asked. */
  | 'watcher-unreachable';

export type ChatActivityTarget =
  | {
      kind: 'unavailable';
      reason: ChatActivityUnavailableReason;
      message: string;
    }
  | {
      kind: 'session';
      target: ChatActivityHostTarget;
      /** What the session calls (`rpc.sdkHost.*`) name the agent by. */
      hostAgentKey: string;
      sessionId: string;
    };

export const ACTIVITY_UNAVAILABLE_TEXT: Record<ChatActivityUnavailableReason, string> = {
  'not-on-this-machine': 'Activity not available on this machine.',
  'not-placed': 'The agent has no session in this chat yet.',
  'watcher-unreachable': "The agent's room watcher cannot be reached.",
};

/**
 * One step of an agent's turn as Switch stores it (`GET /chats/{room}/activity`
 * and the activity feed): the turn's own row (`itemId` {@link TURN_ITEM_ID}),
 * a message, a tool call or a notice. `revision` only grows, so a row at or
 * below the one held is stale.
 */
export const TURN_ITEM_ID = 'turn';

export const chatActivityItemSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  kind: z.enum(['turn', 'user-message', 'assistant-message', 'tool-activity', 'notice']),
  revision: z.number().int(),
  status: z.string(),
  title: z.string(),
  text: z.string(),
  commandId: z.string().nullable(),
  roomId: z.string().nullable(),
  threadId: z.string().nullable(),
  messageId: z.string().nullable(),
  occurredAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatActivityItem = z.infer<typeof chatActivityItemSchema>;

/** A request an agent's session put to a person, in any state, so a settled one survives reload. */
export const chatApprovalSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  requestId: z.string(),
  turnId: z.string(),
  kind: z.string(),
  roomId: z.string().nullable(),
  threadId: z.string().nullable(),
  title: z.string(),
  detail: z.string().nullable(),
  options: z.array(z.object({ id: z.string(), label: z.string(), decision: z.string() })),
  questions: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      prompt: z.string(),
      options: z.array(
        z.object({ id: z.string(), label: z.string(), description: z.string().nullable() })
      ),
      multiSelect: z.boolean(),
      allowCustomAnswer: z.boolean(),
    })
  ),
  state: z.string(),
  expiresAt: z.string().nullable(),
  answer: z.string().nullable(),
  answers: z
    .array(
      z.object({
        questionId: z.string(),
        selectedOptionIds: z.array(z.string()),
        customText: z.string().nullable(),
      })
    )
    .nullable(),
  answeredBy: z.string().nullable(),
  answeredAt: z.string().nullable(),
});
export type ChatApproval = z.infer<typeof chatApprovalSchema>;

export const roomActivitySchema = z.object({
  items: z.array(chatActivityItemSchema),
  approvals: z.array(chatApprovalSchema),
});
export type RoomActivity = z.infer<typeof roomActivitySchema>;

/** An approval's chosen option, or an answer per question. */
export type ChatApprovalAnswer =
  | { answer: string }
  | { answers: NonNullable<ChatApproval['answers']> };

/** A server without the activity routes answers them with an uncoded 404. */
export const SERVER_TOO_OLD_FOR_ACTIVITY =
  'This Switch server is too old for live chat activity — update the server.';

/** What the chat's Stop, Reset and Compact post to the room for an agent. */
/** Stop, Reset and Compact, and `retry`: run again the turn a message started, which failed. */
export type ChatControlCommand = 'interrupt' | 'reset' | 'compact' | 'retry';

export const chatControlAcceptedSchema = z.object({ commandId: z.string() });
