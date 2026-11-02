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

/** What the room is told when the session refused a reset or compaction asked for there. */
export function roomControlRefusal(action: 'reset' | 'compact', reason: string | null): string {
  if (reason?.includes('SESSION_BUSY'))
    return `I can't ${action} my session while I'm working on a turn. Ask again once I've finished, or stop the turn first.`;
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
