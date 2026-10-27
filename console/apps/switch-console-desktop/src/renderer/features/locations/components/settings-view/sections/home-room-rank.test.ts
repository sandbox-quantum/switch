import { describe, expect, it } from 'vitest';
import type {
  RemoteAgentRoom,
  RemoteRoomSummary,
} from '@shared/core/switch-servers/switch-servers';
import { homeRoomOptions } from './home-room-rank';

const room = (roomId: string, extra: Partial<RemoteAgentRoom> = {}): RemoteAgentRoom => ({
  roomId,
  roomName: roomId,
  archived: false,
  status: 'no_session',
  roomRole: null,
  sharedSession: null,
  ...extra,
});

const summary = (id: string, extra: Partial<RemoteRoomSummary> = {}): RemoteRoomSummary => ({
  id,
  name: id,
  description: '',
  channelType: null,
  agentCount: 1,
  bridgeDisplayName: null,
  bridgeType: null,
  externalChannelUrl: null,
  ownerId: null,
  archived: false,
  createdAt: '',
  ...extra,
});

describe('homeRoomOptions', () => {
  it('suggests the rooms the agent is busy in first, then lists the rest by name', () => {
    const rooms = [
      room('zeta'),
      room('busy', { status: 'live' }),
      room('alpha'),
      room('sharing', { sharedSession: 'shared' }),
      room('chat'),
      room('gone', { archived: true }),
    ];
    const summaries: Record<string, RemoteRoomSummary> = {
      chat: summary('chat', { bridgeType: 'mattermost', bridgeDisplayName: 'Mattermost' }),
    };
    const { suggested, all } = homeRoomOptions(rooms, (id) => summaries[id] ?? null);

    expect(suggested.map((option) => option.value)).toEqual(['busy', 'sharing', 'chat']);
    expect(suggested[0]!.detail).toContain('active here');
    expect(suggested[2]!.detail).toBe('Mattermost');
    expect(all.map((option) => option.value)).toEqual(['alpha', 'zeta']);
  });

  it('suggests at most five', () => {
    const rooms = Array.from({ length: 8 }, (_, i) => room(`r${i}`, { status: 'live' }));
    expect(homeRoomOptions(rooms, () => null).suggested).toHaveLength(5);
  });
});
