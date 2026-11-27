/**
 * How an agent's presence in a room reads, and the colour of its dot. An agent
 * that is here has no label: its green dot says so.
 */
export function roomAgentPresence(status: string | undefined): {
  label: string | null;
  tone: 'live' | 'idle' | 'off';
} {
  switch (status) {
    case 'live':
      return { label: null, tone: 'live' };
    case 'awaiting_manual_poll':
      return { label: 'Idle', tone: 'idle' };
    case 'disconnected':
      return { label: 'Disconnected', tone: 'off' };
    case 'no_session':
      return { label: 'No session', tone: 'off' };
    default:
      return { label: 'Status unknown', tone: 'off' };
  }
}
