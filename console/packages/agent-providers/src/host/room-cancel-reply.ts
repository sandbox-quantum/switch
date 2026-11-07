/**
 * What the room is told about a `!cancel` asked for there, from what the
 * host recorded for it: null when it recorded nothing or failed on the way.
 * Only an applied or rejected cancel reads as settled; anything else says it
 * could not be confirmed. No text starts with `!`, so a platform never reads
 * the answer as a command.
 */
export function roomCancelReply(outcome: { status: string; code: string | null } | null): string {
  if (outcome?.status === 'applied')
    return 'Cancelled before the agent started. The agent will not receive it.';
  if (outcome?.status !== 'rejected')
    return "I couldn't confirm the cancellation; check the activity card.";
  switch (outcome.code) {
    case 'TURN_ALREADY_STARTED':
      return "The agent has already started on that message, so it can't be cancelled. To stop the agent's current turn, use `!interrupt` with its mention.";
    case 'TURN_ALREADY_CANCELLED':
      return 'That message was already cancelled.';
    case 'NOT_YOUR_MESSAGE':
      return 'Only the person who sent that message can cancel it.';
    case 'TURN_NOT_FOUND':
      return 'There is no message with that ID waiting for this agent in this room.';
    case 'TURN_NOT_QUEUED':
      return 'That message is no longer waiting, so there is nothing to cancel.';
    default:
      return "I couldn't cancel that message: the session refused it.";
  }
}
