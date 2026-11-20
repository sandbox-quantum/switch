import { describe, expect, it } from 'vitest';
import { roomAgentPresence } from './room-agent-presence';

describe('roomAgentPresence', () => {
  it('names each presence the server reports, and leaves being here to the dot', () => {
    expect(roomAgentPresence('live')).toEqual({ label: null, tone: 'live' });
    expect(roomAgentPresence('awaiting_manual_poll')).toEqual({ label: 'Idle', tone: 'idle' });
    expect(roomAgentPresence('disconnected')).toEqual({ label: 'Disconnected', tone: 'off' });
    expect(roomAgentPresence('no_session')).toEqual({ label: 'No session', tone: 'off' });
  });

  it('does not guess at a presence it does not know', () => {
    expect(roomAgentPresence(undefined)).toEqual({ label: 'Status unknown', tone: 'off' });
    expect(roomAgentPresence('something_new')).toEqual({ label: 'Status unknown', tone: 'off' });
  });
});
