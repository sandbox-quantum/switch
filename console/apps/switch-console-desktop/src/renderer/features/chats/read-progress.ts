/**
 * How far a chat on screen has been read: through the last message, but only
 * while the reader is at the bottom where it shows; scrolled up, new messages
 * wait as unread.
 */
export function readThroughSeq(state: {
  shown: boolean;
  atBottom: boolean;
  lastSeq: number | null;
}): number | null {
  return state.shown && state.atBottom ? state.lastSeq : null;
}
