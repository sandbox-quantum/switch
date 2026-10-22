import { describe, expect, it } from 'vitest';
import type { RemoteRoomSummary } from '@shared/core/switch-servers/switch-servers';
import { groupByMessagingApp } from './rooms-by-messaging-app';

const room = (id: string, bridgeType: string | null): RemoteRoomSummary => ({
  id,
  name: id,
  description: '',
  channelType: 'channel_private',
  agentCount: 0,
  bridgeDisplayName: bridgeType ? 'Acme Slack' : null,
  bridgeType,
  externalChannelUrl: null,
  ownerId: null,
  archived: false,
  createdAt: '',
});

describe('groupByMessagingApp', () => {
  it('heads the rooms in no messaging app as Switch Console, after the apps', () => {
    expect(
      groupByMessagingApp([room('a', null), room('b', 'slack')]).map((group) => group.label)
    ).toEqual(['Acme Slack', 'Switch Console']);
  });
});
