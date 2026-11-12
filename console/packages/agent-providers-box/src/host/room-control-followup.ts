/**
 * What a session is told after a reset or compaction someone asked for from a
 * room: that it worked, and to rejoin the room it was working in. A reset
 * leaves the provider with no memory of the room, its instructions or the
 * role the agent held there, and a compaction may have summarised them away.
 */
export function roomControlFollowup(input: {
  action: 'reset' | 'compact';
  roomId: string;
  threadId: string | null;
  actorId: string;
  requesterName: string | null;
}): string {
  const done = input.action === 'reset' ? 'has been reset' : 'has been compacted';
  const thread = input.threadId ? ` in thread ${JSON.stringify(input.threadId)}` : '';
  return [
    `The requested ${input.action} completed successfully.`,
    `Connect to Switch room ${JSON.stringify(input.roomId)} (reuse its connection if already connected) and read_context before responding.`,
    `If you held a role in that room before the ${input.action}, re-assume it and follow its instructions; if it is unavailable, report that clearly instead of claiming it was restored.`,
    input.requesterName
      ? `Then send a short targeted message to ${JSON.stringify(input.requesterName)}${thread} saying your session ${done} and whether you are ready to continue.`
      : `Then send a short message in the room${thread} saying your session ${done} and whether you are ready to continue.`,
  ].join(' ');
}

/** The follow-up message's command id, fixed by the command it follows. */
export function followupCommandId(commandId: string): string {
  return `${commandId}:followup`;
}

/**
 * The room lines for a reset typed in a room, in the agreed words. Each is said only once the box knows what happened, so no line claims
 * a reset that didn't happen.
 */
/** An awake session took the reset. */
export const RESET_ACCEPTED_LINE = 'Resetting my session: clearing context, then reconnecting.';
/** A resting (parked) session was reset: its saved conversation is cleared. */
export const RESET_RESTING_LINE =
  "I was resting, so I've cleared my saved session. My next reply starts fresh.";
/** The reset could not be done. */
export const RESET_FAILED_LINE =
  "I couldn't reset my session. Send the command again in a minute, or ask my owner to restart me from Switch Console.";

/**
 * How long a session host waits for a session it has just started to finish
 * starting before it hands it a reset: a resting session
 * is started to take its reset, and the provider reports ready a moment after
 * the host is up. Its parent waits this long, and a little more, for the answer.
 */
export const SESSION_READY_MS = 30_000;

/** What the room is told when the session refused a reset or compaction asked for there. */
export function roomControlRefusal(action: 'reset' | 'compact', reason: string | null): string {
  if (reason?.includes('SESSION_BUSY'))
    return `I can't ${action} my session while I'm working on a turn. Ask again once I've finished, or stop the turn first.`;
  if (action === 'reset') return RESET_FAILED_LINE;
  return `I couldn't ${action} my session: ${reason?.replace(/^Error: /, '') || 'the session refused it.'}`;
}

/** What the room is told when the session could not run a message's turn again. */
export function retryRefusal(reason: string | null): string {
  if (reason?.includes('SESSION_BUSY'))
    return "I can only try again once that turn has ended without an answer, and it hasn't.";
  if (reason?.includes('NOT_FOUND'))
    return "I couldn't try that again: my current session never worked on that message.";
  return `I couldn't try that again: ${reason?.replace(/^Error: /, '') || 'the session refused it.'}`;
}
