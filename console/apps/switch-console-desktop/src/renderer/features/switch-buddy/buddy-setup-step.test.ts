import { describe, expect, it } from 'vitest';
import type { ChatSummary } from '@shared/core/chats/chats';
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { buddySetupStep } from './buddy-setup-step';

const slack = { id: 'b-1', type: 'slack', status: 'active' } as RemoteBridge;
const linked = { bridgeId: 'b-1' } as LinkedIdentity;
const slackChat = {
  roomId: 'r-1',
  channelType: 'direct',
  bridgeType: 'slack',
  agents: [{ id: 'a-1' }],
} as ChatSummary;

const base = { agentId: 'a-1', bridges: [], identities: [], chats: [], failed: false };

describe('buddySetupStep', () => {
  it('waits for the reads, and says unknown when one failed, never not connected', () => {
    expect(buddySetupStep({ ...base, bridges: null })).toEqual({ kind: 'loading' });
    expect(buddySetupStep({ ...base, bridges: null, failed: true })).toEqual({ kind: 'unknown' });
  });

  it('walks connect, link, create', () => {
    expect(buddySetupStep(base)).toEqual({ kind: 'connect' });
    expect(buddySetupStep({ ...base, bridges: [{ ...slack, status: 'error' }] }).kind).toBe(
      'connect'
    );
    expect(buddySetupStep({ ...base, bridges: [slack], identities: null })).toEqual({
      kind: 'loading',
    });
    expect(buddySetupStep({ ...base, bridges: [slack] })).toEqual({ kind: 'link', bridge: slack });
    expect(buddySetupStep({ ...base, bridges: [slack], identities: [linked] })).toEqual({
      kind: 'create',
      bridge: slack,
    });
  });

  it('confirms, not assumes, a Slack direct chat with the buddy', () => {
    expect(buddySetupStep({ ...base, bridges: [slack], chats: [slackChat] })).toEqual({
      kind: 'confirm',
      bridge: slack,
    });
    expect(buddySetupStep({ ...base, bridges: [slack], chats: [slackChat], failed: true })).toEqual(
      { kind: 'unknown' }
    );
    expect(
      buddySetupStep({
        ...base,
        bridges: [slack],
        identities: [linked],
        chats: [{ ...slackChat, agents: [] }] as ChatSummary[],
      }).kind
    ).toBe('create');
  });
});
