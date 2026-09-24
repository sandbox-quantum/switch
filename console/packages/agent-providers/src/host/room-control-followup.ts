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
}): string {
  const where = input.threadId
    ? `in the room, in thread ${JSON.stringify(input.threadId)},`
    : 'in the room';
  return [
    `The requested ${input.action} completed successfully.`,
    `Connect to Switch room ${JSON.stringify(input.roomId)} (reuse its connection if already connected) and read_context before responding.`,
    `If you held a role in that room before the ${input.action}, re-assume it and follow its instructions; if it is unavailable, report that clearly instead of claiming it was restored.`,
    `Send a short message ${where} confirming the ${input.action} succeeded and whether you are ready to continue.`,
  ].join(' ');
}

/** The follow-up message's command id, fixed by the command it follows. */
export function followupCommandId(commandId: string): string {
  return `${commandId}:followup`;
}
