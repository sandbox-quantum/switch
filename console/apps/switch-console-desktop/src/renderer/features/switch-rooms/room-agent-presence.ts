/** How an agent's presence in a room reads, and the colour of its dot. */
export function roomAgentPresence(status: string | undefined): {
  label: string;
  tone: 'live' | 'idle' | 'off';
} {
  switch (status) {
    case 'live':
      return { label: 'Here now', tone: 'live' };
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
